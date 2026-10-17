---
title: Diagrams
---

# Diagrams

## Flow

The paragraph before the diagram.

```mermaid
flowchart LR
  A["Write the spec"] --> B["Review"]
  B --> C["Ready to build"]
```

The paragraph after the diagram.

## Broken

```mermaid
flowchart LR
  A --> -->
```

Text after the broken diagram.

## Hostile labels

```mermaid
flowchart LR
  A["<img src=x onerror=window.hit=1>"] --> B["<script>window.hit=2</script>"]
  C["link"] --> D
  click C "javascript:window.hit=3"
  click D call alert()
```

## Directive

```mermaid
%%{init: {"securityLevel": "loose", "theme": "dark", "themeCSS": "svg { background: red; } body { background: red; }", "fontFamily": "Comic Sans MS", "htmlLabels": true}}%%
flowchart LR
  E["<img src=x onerror=window.hit=4>"] --> F
  click F call alert()
```

## Front matter

```mermaid
---
config:
  securityLevel: loose
  theme: forest
  themeCSS: "body { background: red; }"
  fontFamily: Comic Sans MS
---
flowchart LR
  G --> H
```

## Styled

```mermaid
flowchart LR
  S["Styled"]:::hot --> T
  classDef hot fill:#999999,stroke:#333333
  style T fill:#888888
```

## Code

```ts
const answer: number = 42;
```
