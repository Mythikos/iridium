/** Worker-only fault fixture: a CPU loop must be terminated, never left alive after a deadline. */
export default function projectFixture(task) {
  if (task.started !== undefined) Atomics.store(new Int32Array(task.started), 0, 1);
  if (task.kind === 'spin')
    for (;;) {
      /* deliberately uncooperative CPU work */
    }
  if (task.kind === 'throw') throw new Error('fixture parser failure');
  return { value: task.value };
}
