# GamePlan frontend — v3.2.8 Fix 01

Static Summit Dark PWA connected to the GamePlan Apps Script API and CMS.

For local development, serve this directory through VS Code Live Server. Opening `index.html` directly may prevent module and service-worker behavior from working correctly.

Public deployment configuration belongs in `js/config.js`. Do not place server credentials, PINs, customer exports, or private operational data in GitHub.

This release requires the matching Fix 01 Apps Script backend and a CMS with `JobEquipment.ProductID`.
