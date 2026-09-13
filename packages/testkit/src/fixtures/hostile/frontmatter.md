---
title: "<script>window.__pwned=1</script>"
python: !!python/object/apply:os.system ["echo pwned"]
a: &anchor ["x","x","x","x","x","x","x","x","x"]
b: &b [*anchor,*anchor,*anchor,*anchor,*anchor,*anchor,*anchor,*anchor,*anchor]
c: &c [*b,*b,*b,*b,*b,*b,*b,*b,*b]
d: [*c,*c,*c,*c,*c,*c,*c,*c,*c]
dup: one
dup: two
	tabbed: value
---

# Frontmatter

The block above must be rejected or neutralised without executing anything.
