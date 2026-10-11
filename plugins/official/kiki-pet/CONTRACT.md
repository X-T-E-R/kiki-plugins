# Pet frontend contract v1

## Files and ownership

Frontend owns `panel/index.html`, `panel/panel.js`, `panel/style.css`, `runtime/ui/index.html`, `runtime/ui/pet.mjs`, `runtime/ui/style.css`. Logic owner owns everything else. Use vanilla ES modules and no remote JS/fonts. UI files are embedded into the standalone Tauri executable, so complete them before the final runtime build. Panel assets must be listed in the manifest by logic owner. GPL-3.0-or-later applies to OpenPet-adapted frontend/runtime; keep source license notice.

## Panel bridge

Use the verified Cloudflare Host candidate bridge: send `{channel:'kiki.panel.v1',kind:'request',id:number,method:'plugin.call',action,args}` via `parent.postMessage(...,'*')`. Accept only results from `event.source===parent` with `{channel:'kiki.panel.v1',kind:'response',id,ok,result?,error?}`. Host init is `{channel:'kiki.panel.v1',kind:'init',sessionId:string|null}`. There is no panel streaming subscription; `state` polling every 2 seconds while visible is sufficient. Existing external-link method is `plugin.openExternal` with top-level `url`. **There is no navigateSession panel method.** Use ordinary backend `focus` only: it returns `{sessionId}` and calls the private candidate's generic App-context `focusSession(sessionId)`. The candidate publishes one bounded, expiring focus receipt at `/plugins/navigation`, read by the App shell independently of the pet panel, so native pet focus does not depend on its management panel being open. Do not send an invented second navigation message.

Backend actions return a complete Snapshot except import, which returns `{pet, state}`:

- `state`, `start`, `stop`: no args. `start` is also explicit recovery, with no automatic restart loop. Stop does not disable the plugin or erase pets.
- `import`: `{source:string, license?:string, author?:string}`; source is a local directory, `pet.json`, `.zip`/`.petpack`, WebP path, or public https page/package URL. Import permission/terms are preserved; do not suggest it is a license grant.
- `select`: `{id:string}` from `pets`.
- `settings`: partial `{scale:0.5..2.5, paused:boolean, reducedMotion:boolean, autonomousWalking:boolean, hoverPause:boolean, idleSelfPlay:boolean, eventReactions:boolean, eventBubbles:boolean, bubbleTtlMs:1000..10000}`.
- `action`: `{animationId}` from activePet.animations, optional `{durationMs:500..10000}`.
- `say`: `{text:string<=160, ttlMs?:1000..10000}`. Text only, never HTML.
- `focus`: no args. Returns `{sessionId?:string}` for current activity.

Errors reject with a readable string. Retain user input and render error in place. Empty source catalog is not an empty installed pet list.

## Snapshot

```
{
 version:1,
 runtime:{status:'stopped'|'starting'|'running'|'failed',pid?:number,error?:string},
 settings:{scale,paused,reducedMotion,autonomousWalking,hoverPause,idleSelfPlay,eventReactions,eventBubbles,bubbleTtlMs},
 pets:[Pet], activePet:Pet,
 activity:{phase:'idle'|'working'|'waiting'|'completed'|'failed',sessionId?:string,reason?:'approval'|'question'|'cancelled',at:number},
 action:{animationId:string,until:number}|null,
 bubble:{text:string,until:number}|null,
 focusRequest:{sessionId:string,at:number}|null,
 sources:[{id,label,url,description,licenseNote}]
}
Pet = {id,displayName,description,spriteUrl:'data:image/webp;base64,...',
 atlas:{width,height,columns,rows,cellWidth,cellHeight},
 animations:{[animationId]:{row,frameCount,frameDurationsMs:number[]}},
 provenance:{sourceUrl?,sourceName,license,author?,importedAt,sha256}}
```

**Image caching:** Panel `state`, `import` and other mutation results contain Pet descriptors without spriteUrl. Fetch action `asset` with `{id,sha256:pet.provenance.sha256}` once per id+hash; response is `{id,sha256,spriteUrl}` (PNG or WebP data URL). Cache it, use cached images for visible list previews and selected animated preview; do not refetch images on state polling. Native `pet-state` includes activePet.spriteUrl only on first state or changed id+hash; retain that image in a cache while later descriptor-only events update settings/activity. `pet_snapshot` returns current active image once for initial load. Never concatenate untrusted paths into asset URLs. Normalized geometry is authoritative, not fixed 8×9. Codex v2 atlas additionally has `gaze:{neutral:{row:0,column:6},frames:[{row:9|10,column:0..7} x16],deadZonePx:24,resetAfterMs:1200}`. These are static gaze frames (index0 up, clockwise22.5°), not sleeping/happy animations; ordinary rows0–8 remain unchanged. Use gaze only idle/unpaused after mouse movement; restore neutral after1200ms. Unknown custom actions fall back to idle; working→running, waiting→waiting, completed→waving, failed→failed. Honor frameDurationsMs and paused/reducedMotion. Imported metadata is text.

## Runtime Tauri bridge

`await window.__TAURI__.core.invoke('pet_snapshot')` returns Snapshot (may initially be null; show a quiet connecting state).
`window.__TAURI__.event.listen('pet-state',event=>render(event.payload))` receives Snapshot.
`await invoke('pet_dispatch',{action,args})` accepts only settings/action/say/stop/focus; no arbitrary shell/path/network calls.
`invoke('pet_heartbeat')` every 1000ms, including while paused. If JS stalls, supervisor marks failed and closes only this owned runtime after 6 seconds.
Native dragging: `window.__TAURI__.window.getCurrentWindow().startDragging()` after a primary pointer drag; right click shows local menu; click action waving/jumping or focus status bubble. A native drag ends normally; do not continuously dispatch pointer coordinates. `pet_resize` `{width,height}` clamps width 120..700 height 120..800; only use when scale/sprite geometry changes. `pet_move` `{dx,dy}` clamps deltas to ±24px and keeps the window in the current monitor work area, for opt-in autonomous walking.

## UI acceptance intent

Compact paper-and-ink Kiki panel: installed pets with preview/attribution, import field, start/recover/exit status, scale and pause, useful advanced behavior settings. No stacked diagnostic cards. Native transparent pet is immediately usable with original default companion; restrained action feedback, readable short bubbles, drag/context menu, pause/exit. Never display prompt bodies, task content or credentials. Show phase and navigate to relevant session on user action.
