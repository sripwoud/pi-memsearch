# Maintenance profiles (PROJECT.md / USER.md)

No background pass distills the memory store into a project profile or a user profile.

## Why this is out of scope

The two artifacts already have owners. A condensed view of the store on request is `memory_compact`; durable who-the-user-is knowledge is what capture and recall exist for. A background runner would add a second LLM writer beside compaction and spend the user's budget without an explicit ask — the same principle that made `memory_compact` on-request only. The upstream precedent argues the same way: the memsearch pi plugin (zilliztech/memsearch#650) ships these tasks disabled by default, which is a feature announcing its own weak demand.

If demand materializes, it arrives as its own feature with an explicit trigger (a tool call or a command, never a timer) — not as a port of the maintenance runner.

## Prior art

- [zilliztech/memsearch#650](https://github.com/zilliztech/memsearch/pull/650) — `project_review`, `user_profile`, `memory_to_skill` tasks via a plugin-local maintenance runner, all disabled by default
