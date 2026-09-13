# Markdown specific

Inline code must stay literal: `<script>window.__pwned=1</script>`

```html
<script>window.__pwned=2</script>
```

> <script>window.__pwned=3</script>

- <script>window.__pwned=4</script>

Autolink literal: javascript:window.__pwned=5

[^<script>window.__pwned=6</script>]: a footnote label

[titled](https://example.invalid/ "a \" and a > inside the title")

![alt with <b>markup</b> and <script>window.__pwned=7</script>](https://example.invalid/i.png)

***nested*emphasis**that*resolves*differently*
