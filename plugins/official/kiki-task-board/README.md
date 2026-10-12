# Task board

Optional official plugin for persistent requirement cards. Kiki does not load a task board until this plugin is installed and enabled.

Cards stay in the Own Work store they were created in. Each card keeps the storage address recorded when it was created. `taskBoard.storage` in the Kiki home `config.toml` still chooses the default address for a new card: `auto`, `global`, or `fixed`. Changing that setting does not move existing cards. A read does not rewrite card files.

Requires a Kiki host supporting plugin protocol `0.4.1` or later. Install and enable `kiki-task-board`, then open its workspace panel from **Capabilities → Plugins** and select a workspace. The panel lists registered workspaces from `workspaces.json`; it reads and saves the same cards as `plugin__kiki_task_board__BoardRead` and `plugin__kiki_task_board__BoardWrite`.

Historical conversations keep their original tool names and recorded results. Without this plugin, those conversations still open and accept ordinary messages. A new call to an unavailable tool reports that it is missing; historical writes are not replayed.
