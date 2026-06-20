/**
 * UI copy regression for the Activity/TODO taxonomy.
 * Run: npx tsx apps/web/scripts/activity-copy.test.ts
 */
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const root = new URL("..", import.meta.url).pathname;
const read = (rel: string) => readFileSync(join(root, rel), "utf8");

const rail = read("components/LeashRail.tsx");
assert.match(rail, /href: "\/activity", label: "Activity"/, "the Activity rail item links to /activity");
assert.match(rail, /startsWith\("\/activity"\)/, "the rail marks /activity active");
assert.doesNotMatch(rail, /href: "\/tasks"/, "the rail no longer links to /tasks");
assert.doesNotMatch(rail, /href: "\/tasks", label: "Tasks"/, "the rail no longer exposes Tasks as the page label");

assert.ok(existsSync(join(root, "app/activity/page.tsx")), "Activity page lives at app/activity/page.tsx");
assert.ok(!existsSync(join(root, "app/tasks/page.tsx")), "old app/tasks page route is removed");

const page = read("app/activity/page.tsx");
assert.match(page, /`\/activity\?/, "Activity tab links preserve query params on /activity");
assert.doesNotMatch(page, /`\/tasks\?|\/tasks"/, "Activity page does not link to /tasks");
assert.match(page, /title="Activity"/, "the page title is Activity");
assert.match(page, /kicker="Leash · Activity"/, "the page kicker is Activity");
assert.match(page, /todo: "TODOs"/, "the user-work tab is labeled TODOs");
assert.doesNotMatch(page, /title="Tasks"/, "the page no longer presents itself as Tasks");
assert.doesNotMatch(page, /"mine"/, "the old Mine tab key is removed so the default tab renders TODOs");

assert.ok(existsSync(join(root, "components/ActivityPanel.tsx")), "Activity surface panel is named ActivityPanel");
assert.ok(!existsSync(join(root, "components/TasksPanel.tsx")), "old TasksPanel component file is removed");

const panel = read("components/ActivityPanel.tsx");
assert.match(panel, /\/api\/leash\/todos/, "TODO panel uses the TODO API route");
assert.doesNotMatch(panel, /\/api\/leash\/tasks/, "TODO panel no longer calls the old task API route");
for (const text of ["New TODO", "TODO created", "TODO updated", "Delete this TODO?", "Delete selected TODOs", "Select all listed TODOs", "No TODOs match", "Add TODO", "Select TODO", "Delete TODO"]) {
  assert.ok(panel.includes(text), `ActivityPanel exposes TODO wording: ${text}`);
}
assert.doesNotMatch(panel, /New task|Task created|Task updated|Task deleted|No tasks match|Select all listed tasks|Delete selected task|Couldn't create the task|Add task|Select task|Delete task/, "TODO panel does not use visible Task wording for user work");

const home = read("app/home/page.tsx");
assert.match(home, /title="Activity"/, "home card links to Activity");
assert.match(home, /href="\/activity"/, "home card links to /activity");
assert.doesNotMatch(home, /href="\/tasks"/, "home card does not link to /tasks");
assert.match(home, /All activity →/, "home card action is Activity");
assert.match(home, /Open TODOs/, "home card distinguishes user TODOs from activity");

const chat = read("components/LeashChat.tsx");
assert.match(chat, /`\/activity\?tab=runs&run=\$\{event\.id\}`/, "run evidence links point to Activity");
assert.doesNotMatch(chat, /`\/tasks\?tab=runs/, "run evidence links do not point to /tasks");

const brokers = read("lib/leash/tool-brokers.ts");
assert.match(brokers, /label: "TODOs"/, "assistant todo broker is labeled TODOs");

assert.ok(existsSync(join(root, "app/api/leash/todos/route.ts")), "TODO API collection route exists");
assert.ok(existsSync(join(root, "app/api/leash/todos/[id]/route.ts")), "TODO API item route exists");
assert.ok(!existsSync(join(root, "app/api/leash/tasks/route.ts")), "old task API collection route is removed");
assert.ok(!existsSync(join(root, "app/api/leash/tasks/[id]/route.ts")), "old task API item route is removed");

const todosApi = read("app/api/leash/todos/route.ts");
assert.match(todosApi, /Response\.json\(\{ todos: tasks \}\)/, "TODO collection API returns todos");
assert.match(todosApi, /Response\.json\(\{ todo: task \}/, "TODO create API returns todo");

const todoApi = read("app/api/leash/todos/[id]/route.ts");
assert.match(todoApi, /Response\.json\(\{ todo: task \}\)/, "TODO update API returns todo");
