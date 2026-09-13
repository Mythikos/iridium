# Iridium MySQL role provisioning (03-data-model.md section 2, 11-operations-and-deployment.md
# "Roles: infra/docker/mysql/init/01_roles.sh", OPS-11).
#
# The official mysql image runs files from /docker-entrypoint-initdb.d once, on the first start of an
# empty data directory. A `.sh` file there is EXECUTED when it carries the execute bit and SOURCED
# when it does not; this file is deliberately not executable, because only the sourced form sees the
# entrypoint's own `docker_process_sql`, `mysql_note` and `mysql_error` helpers. A plain `.sql` file
# could do neither of the two things this script exists for: read a password out of a *_FILE secret
# instead of embedding it, and fail the container's initialisation on the authentication-plugin
# assertion of 03-data-model.md section 1.1. It still works when a copy of it arrives with the bit
# set -- the helpers are all optional below -- so a `docker cp` that does not preserve the mode
# degrades to a clear error instead of a mystery.
#
# Being sourced also means this script must not change the entrypoint's shell options (no `set -e`,
# no `set -u`): every failure is handled explicitly below.
#
# Secrets, each a path to a file holding one password and nothing else:
#   IRIDIUM_DB_APP_PASSWORD_FILE       -> iridium_app
#   IRIDIUM_DB_MIGRATOR_PASSWORD_FILE  -> iridium_migrator
#   IRIDIUM_DB_BACKUP_PASSWORD_FILE    -> iridium_backup
#
# Table-level rights for iridium_app are NOT granted here: grants require the tables to exist, so
# they are migration 0034_grants and a companion NNNN_<table>_grants for every table added later.

iridium_roles_note() {
  if command -v mysql_note >/dev/null 2>&1; then
    mysql_note "01_roles.sh: $1"
  else
    printf '[Note] 01_roles.sh: %s\n' "$1"
  fi
}

iridium_roles_fail() {
  if command -v mysql_error >/dev/null 2>&1; then
    mysql_error "01_roles.sh: $1" # mysql_error exits non-zero, failing container initialisation
  else
    printf '[ERROR] 01_roles.sh: %s\n' "$1" >&2
    exit 1
  fi
}

# Reads a *_FILE secret and prints it with any trailing newline removed. Fails when the variable is
# unset, the file is unreadable, or the password is empty: a blank password would create an account
# anyone can connect as.
iridium_roles_secret() { # $1 = variable name, $2 = path
  if [ -z "$2" ]; then
    iridium_roles_fail "$1 is not set; it must name a file holding the password"
  fi
  if [ ! -r "$2" ]; then
    iridium_roles_fail "$1=$2 is not readable"
  fi
  iridium_roles_secret_value=$(cat "$2")
  if [ -z "$iridium_roles_secret_value" ]; then
    iridium_roles_fail "$1=$2 is empty"
  fi
  printf '%s' "$iridium_roles_secret_value"
}

# Escapes a password for a single-quoted MySQL string literal: backslash first, then quote.
iridium_roles_quote() {
  printf '%s' "$1" | sed -e 's/\\/\\\\/g' -e "s/'/''/g"
}

# Escapes and refuses to continue on an empty result. An escaping bug that silently produced an
# empty string would create an account with a blank password, which is the one failure this script
# must never have.
iridium_roles_quote_checked() { # $1 = label, $2 = password
  iridium_roles_quoted=$(iridium_roles_quote "$2")
  if [ -z "$iridium_roles_quoted" ]; then
    iridium_roles_fail "escaping the $1 password produced an empty string; refusing to create an account without a password"
  fi
  printf '%s' "$iridium_roles_quoted"
}

# Runs the statements on stdin as root. `docker_process_sql` is the entrypoint's own helper and is
# what the sourced form uses; the fallback exists so a copy of this file that arrived with the execute
# bit set still works, and it accepts the root password in either spelling the image does
# (`MYSQL_ROOT_PASSWORD` or `MYSQL_ROOT_PASSWORD_FILE`, which is what infra/compose.yaml sets).
# `MYSQL_PWD` rather than `-p` keeps the password off the command line and keeps the client's
# "using a password on the command line interface can be insecure" warning out of the output.
iridium_roles_sql() { # reads the statements from stdin
  if command -v docker_process_sql >/dev/null 2>&1; then
    docker_process_sql --database=mysql "$@"
  else
    iridium_roles_root_pw="${MYSQL_ROOT_PASSWORD-}"
    if [ -z "$iridium_roles_root_pw" ] && [ -n "${MYSQL_ROOT_PASSWORD_FILE-}" ] &&
      [ -r "${MYSQL_ROOT_PASSWORD_FILE}" ]; then
      iridium_roles_root_pw=$(cat "${MYSQL_ROOT_PASSWORD_FILE}")
    fi
    MYSQL_PWD="$iridium_roles_root_pw" mysql --protocol=socket -uroot --database=mysql "$@"
  fi
}

iridium_roles_main() {
  iridium_roles_app=$(iridium_roles_secret IRIDIUM_DB_APP_PASSWORD_FILE "${IRIDIUM_DB_APP_PASSWORD_FILE-}") || return 1
  iridium_roles_migrator=$(iridium_roles_secret IRIDIUM_DB_MIGRATOR_PASSWORD_FILE "${IRIDIUM_DB_MIGRATOR_PASSWORD_FILE-}") || return 1
  iridium_roles_backup=$(iridium_roles_secret IRIDIUM_DB_BACKUP_PASSWORD_FILE "${IRIDIUM_DB_BACKUP_PASSWORD_FILE-}") || return 1

  iridium_roles_app_q=$(iridium_roles_quote_checked iridium_app "$iridium_roles_app") || return 1
  iridium_roles_migrator_q=$(iridium_roles_quote_checked iridium_migrator "$iridium_roles_migrator") || return 1
  iridium_roles_backup_q=$(iridium_roles_quote_checked iridium_backup "$iridium_roles_backup") || return 1

  iridium_roles_note 'creating the iridium schema and the three least-privilege roles'

  iridium_roles_sql <<SQL || return 1
CREATE DATABASE IF NOT EXISTS iridium CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci;

CREATE USER IF NOT EXISTS 'iridium_app'@'%'      IDENTIFIED WITH caching_sha2_password BY '${iridium_roles_app_q}'      PASSWORD EXPIRE NEVER;
CREATE USER IF NOT EXISTS 'iridium_migrator'@'%' IDENTIFIED WITH caching_sha2_password BY '${iridium_roles_migrator_q}' PASSWORD EXPIRE NEVER;
CREATE USER IF NOT EXISTS 'iridium_backup'@'%'   IDENTIFIED WITH caching_sha2_password BY '${iridium_roles_backup_q}'   PASSWORD EXPIRE NEVER;

-- migrator: everything inside the iridium schema, nothing global; GRANT OPTION is scoped to the
-- schema so migration 0034_grants can grant per-table rights to iridium_app.
GRANT SELECT, INSERT, UPDATE, DELETE, CREATE, DROP, ALTER, INDEX, REFERENCES, TRIGGER, EVENT,
      CREATE VIEW, SHOW VIEW, LOCK TABLES, CREATE TEMPORARY TABLES
  ON iridium.* TO 'iridium_migrator'@'%' WITH GRANT OPTION;

-- backup: read everything, take consistent dumps, read binlog coordinates, and stream closed binary
-- logs over the protocol. REPLICATION SLAVE is what mysqlbinlog --read-from-remote-server requires
-- (OPS-40); RELOAD only covers the FLUSH BINARY LOGS that closes them.
GRANT SELECT, LOCK TABLES, SHOW VIEW, TRIGGER, EVENT ON iridium.* TO 'iridium_backup'@'%';
GRANT RELOAD, PROCESS, REPLICATION CLIENT, REPLICATION SLAVE ON *.* TO 'iridium_backup'@'%';
-- BACKUP_ADMIN: --single-transaction together with --source-data makes mysqldump take an instance
--   backup lock (LOCK INSTANCE FOR BACKUP), which needs it; the behaviour dates from 8.0.21 and the
--   floor is 8.4.11, so it holds on both required lines. Both flags are settled (A47, OPS-26), so
--   this grant is not optional.
-- SHOW_ROUTINE: --routines needs either global SELECT or SHOW_ROUTINE to read routine definitions;
--   SHOW_ROUTINE is the narrow one (OPS-45).
GRANT BACKUP_ADMIN, SHOW_ROUTINE ON *.* TO 'iridium_backup'@'%';

-- app: USAGE only here; per-table DML arrives with migration 0034_grants once the tables exist.
GRANT USAGE ON *.* TO 'iridium_app'@'%';
FLUSH PRIVILEGES;
SQL

  # The last step is an assertion, not a grant. The password plugin removed in 9.0 still exists on
  # 8.4 as a loadable component that is disabled by default, so a data directory initialised with it
  # loaded could otherwise produce a role Iridium did not intend. Failing here puts that discovery in
  # container initialisation rather than at the first connection.
  iridium_roles_wrong=$(printf '%s\n' "SELECT COUNT(*) FROM mysql.user WHERE user IN ('iridium_app','iridium_migrator','iridium_backup') AND plugin <> 'caching_sha2_password';" | iridium_roles_sql --skip-column-names --batch) || return 1
  if [ -z "$iridium_roles_wrong" ]; then
    iridium_roles_fail 'the authentication-plugin assertion returned no rows'
  fi
  if [ "$iridium_roles_wrong" != "0" ]; then
    iridium_roles_fail "$iridium_roles_wrong of the three Iridium roles are not using caching_sha2_password"
  fi

  iridium_roles_note 'iridium_app, iridium_migrator and iridium_backup are ready (caching_sha2_password)'
}

iridium_roles_main || iridium_roles_fail 'role provisioning failed'
