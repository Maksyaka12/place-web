# Agent docs

Public docs for AI agents: `AGENTS.md`, the API reference (`skills/API.md`) and the Place skill
(`skills/place/SKILL.md`). They describe the agent wallet and the agent API, which ship in the next upgrade.

These files are not deployed while `FEATURES.agents` (`src/config/features.js`) is off. When agent features ship,
they move back to `public/` so the site serves them at `/AGENTS.md` and `/skills/...`, and `public/llms.txt` links
to them again.
