# DOM clobbering

<a id="document" href="#a">one</a>
<a name="body" href="#b">two</a>
<a id="__proto__" href="#c">three</a>
<a id="x" href="#d">four</a>
<a name="x" href="#e">five</a>
<form id="location"><input name="href" value="https://sink.invalid/beacon"></form>

## A heading that becomes an id
