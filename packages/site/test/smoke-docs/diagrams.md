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

## Wide

```mermaid
flowchart LR
  W1["Owner buys credits"] --> W2["Creates a campaign"] --> W3["Admin approves the campaign"] --> W4["Clipper finds the campaign"] --> W5["Clipper posts a clip and submits the link"] --> W6["Owner or admin approves the clip"] --> W7["Views tracked live"] --> W8["View cutoff"] --> W9["Weekly payout run"] --> W10["Clipper gets paid"]
```

## Tall

```mermaid
flowchart TB
  T1 --> T2 --> T3 --> T4 --> T5 --> T6 --> T7 --> T8 --> T9 --> T10 --> T11 --> T12 --> T13 --> T14 --> T15 --> T16
```

## Code

```ts
const answer: number = 42;
```
