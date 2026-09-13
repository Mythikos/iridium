# CSS injection

<div style="background:url(javascript:window.__pwned=1)">a</div>

<style>@import url("https://sink.invalid/beacon");</style>

<div style="width:expression(window.__pwned=2)">b</div>

<div style="-moz-binding:url(https://sink.invalid/beacon)">c</div>

<span class="hljs-keyword">a forged highlight class</span>
