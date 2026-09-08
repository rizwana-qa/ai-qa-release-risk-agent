# Presentation

Slide deck explaining the idea, who it helps, how it works layer by layer,
exactly where the AI (Gemini API) is used, and where human control is placed.

| File | Use |
| --- | --- |
| `AI-QA-Release-Risk-Agent.pptx` | PowerPoint — open in PowerPoint / Google Slides / Keynote and present. Each slide is a rendered image (Marp `--pptx` output), not editable text. |
| `AI-QA-Release-Risk-Agent.pdf` | Print / share / read. |
| `ai-qa-release-risk-agent.md` | The source. A [Marp](https://marp.app/) deck — each `---` is a slide. Reads fine as a plain doc on GitHub. Edit this, then re-export. |

## Re-export after editing the source

From the repo root (`ai-qa-release-risk-agent/`):

```bash
npx --yes @marp-team/marp-cli presentation/ai-qa-release-risk-agent.md --pptx -o presentation/AI-QA-Release-Risk-Agent.pptx
npx --yes @marp-team/marp-cli presentation/ai-qa-release-risk-agent.md --pdf  -o presentation/AI-QA-Release-Risk-Agent.pdf
npx --yes @marp-team/marp-cli presentation/ai-qa-release-risk-agent.md --html -o presentation/AI-QA-Release-Risk-Agent.html   # interactive slides
```

Or install **Marp for VS Code** and use its preview / export.

## One-line summary

The LLM reads the spec, tests and defects and explains the risk; a
human-authored deterministic rule set — not the model — makes the final
GO / NO-GO / CONDITIONAL decision. One of seven layers calls the API, and it
never touches the decision.
