# Station backend endpoints

These files add the `/api/station/...` endpoints that the desktop app uploads run reports and defect snapshots to.
They are written for **VisionBackend** and use its auth middleware, permissions and workspace scoping, so they only run from inside that project.

Until they are installed, the station works fully offline: runs are saved on the PC and the upload queue simply waits.

## Install into VisionBackend

1. Copy the files, keeping the same folders:
   - `routes/station.js` → `VisionBackend/routes/station.js`
   - `controllers/stationController.js` → `VisionBackend/controllers/stationController.js`
   - `models/StationRun.js` → `VisionBackend/models/StationRun.js`
   - `models/StationDefect.js` → `VisionBackend/models/StationDefect.js`
2. In `VisionBackend/server.js`, add next to the other route imports:
   ```js
   const stationRoutes = require('./routes/station');
   ```
   and next to the other `app.use('/api/...')` lines:
   ```js
   app.use('/api/station', stationRoutes);
   ```
3. Restart the backend.

## Endpoints

| Method | Path | Purpose |
|---|---|---|
| POST | `/api/station/runs` | Create/update a run (idempotent on `clientRunId`) |
| POST | `/api/station/runs/:runId/defects` | Upload one defect snapshot (multipart, idempotent on `clientDefectId`) |
| GET | `/api/station/runs` | List runs for the workspace |
| GET | `/api/station/runs/:runId` | Run + defect log |
| GET | `/api/station/runs/:runId/defects/:defectId/image` | Defect snapshot |

Uploading needs the `runInference` permission; reading needs `viewInferenceResults`. Data is scoped to the user's company.
