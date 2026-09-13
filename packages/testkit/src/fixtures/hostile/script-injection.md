# Script injection

<script>window.__pwned = 1</script>

<script src="https://sink.invalid/beacon"></script>

<script type="module">import("https://sink.invalid/beacon")</script>

<scr<script>ipt>window.__pwned = 2</scr</script>ipt>

<svg><script>window.__pwned = 3</script></svg>

<math><mtext><script>window.__pwned = 4</script></mtext></math>

<template><script>window.__pwned = 5</script></template>

<SCRIPT >window.__pwned = 6</SCRIPT >
