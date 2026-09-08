# Presentation

`ai-qa-release-risk-agent.md` — a slide deck explaining the idea, who it helps,
how it works layer by layer, exactly where the AI (Gemini API) is used, and
where human control is placed.

It is a [Marp](https://marp.app/) deck: each `---` is a slide. It also reads
fine as a plain document on GitHub.

## View it

- **On GitHub** — just open the `.md` file; it renders top to bottom.
- **As slides (VS Code)** — install the *Marp for VS Code* extension, open the
  file, click the preview icon.
- **Export to PDF / HTML / PPTX** (no install kept in the repo):

  ```bash
  npx --yes @marp-team/marp-cli presentation/ai-qa-release-risk-agent.md --pdf
  npx --yes @marp-team/marp-cli presentation/ai-qa-release-risk-agent.md --html
  npx --yes @marp-team/marp-cli presentation/ai-qa-release-risk-agent.md --pptx
  ```

## One-line summary

The LLM reads the spec, tests and defects and explains the risk; a
human‑authored deterministic rule set — not the model — makes the final
GO / NO‑GO / CONDITIONAL decision. One of seven layers calls the API, and it
never touches the decision.
