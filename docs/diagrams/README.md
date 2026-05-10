# Diagrams

Three "Old vs New" visualizations — pick whichever fits your audience.

## 1. Excalidraw (hand-drawn / sketchy — best for LinkedIn)

Shareable, editable URL:
**<https://excalidraw.com/#json=1hqEGZmaC4VagemqfWeUg,Q0i_UjQwU_lJM4or0xLCHg>**

Open it, tweak whatever you want, then **Menu → Save to PNG** (or Export image, transparent / white background). The hand-drawn feel reads as personal/human and tends to outperform polished diagrams in social feeds.

## 2. Mermaid (`old-vs-new.mmd`) — clean / technical

Render via:
- **Web**: paste the file contents into <https://mermaid.live>, then **Actions → Download PNG / SVG**
- **CLI**: `npx -p @mermaid-js/mermaid-cli mmdc -i old-vs-new.mmd -o old-vs-new.png -w 1600`
- **GitHub**: GitHub renders Mermaid in markdown automatically — paste the file contents into a fenced ```mermaid block

## 3. HTML/CSS mockup (`old-vs-new.html`) — pixel-perfect, matches the actual demo

Open the file in any browser:
```bash
open old-vs-new.html
```
Then screenshot the centered card (Cmd+Shift+4 on macOS, drag to select). The right panel shows the actual restaurant card from the demo — same gradient, same pills, same Add to Cart button. Most accurate visual for the LinkedIn post.

## Which to use?

| Audience | Pick |
|---|---|
| LinkedIn (general / mixed) | Excalidraw — hand-drawn outperforms |
| GitHub README / dev tweet | Mermaid — it renders inline |
| Polished blog / press / pitch deck | HTML/CSS — looks like a real product screenshot |
