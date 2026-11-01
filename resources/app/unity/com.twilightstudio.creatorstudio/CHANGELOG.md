# Changelog

## 0.2.1

- Scene view orbit now uses standard camera-orbit directions around the pivot.
- Pointer-lock support was tightened on the app side; restarting the desktop
  app loads the pointer-lock permission required for a locked orbit.

## 0.2.0

- Deep editor tool surface: inspect objects and serialized properties, search
  objects and assets, add/remove/toggle components, set inspector or runtime
  properties, move/rotate/scale/reparent/rename/tag/layer, create empty objects,
  create/apply/edit materials, open and save scenes, change common project
  settings and clear the compile log.
- Every scene change now registers undo, marks the scene dirty and frames the
  changed GameObject in the Scene view for live feedback.
- Compile clears the previous log, refreshes assets and requests script
  compilation. The AI then reads unity_state compileMessages and fixes errors.
- Natural Scene view orbit using the camera's local right axis, with pointer
  lock support in the app.

## 0.1.5

- Fixed scene-view orbit direction: dragging right now moves the scene with the
  cursor (camera orbits left) and dragging down looks down from above, matching
  Unity's own Alt+LMB behaviour.
- Added pointer-lock support on the app side so long orbit drags no longer run
  off screen.

## 0.1.4

- Added create, duplicate, delete, transform and active-state commands for AI-driven Unity editing.

## 0.1.3

- Flattened hierarchy serialization so deep Unity scenes no longer hit the JsonUtility depth limit.

## 0.1.2

- Added scene-view orbit, zoom and pan commands for app-driven camera control.
- Focus now frames the selected GameObject in the Scene view and repaints it.
- Keeps scene/game viewport capture from 0.1.1.

## 0.1.0

- Initial local Unity Editor bridge for AI Creator Studio by Twilight Studio.
- Loopback HTTP endpoints for project/scene state, hierarchy, focus, refresh,
  compile, play/stop, and open scene.
- Auto-start menu and local port discovery.
