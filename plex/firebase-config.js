// ============================================================
//  PickFlick — Firebase Configuration
// ============================================================
//
//  SETUP (takes ~5 minutes):
//
//  1. Go to https://console.firebase.google.com
//  2. Click "Add project" → name it "pickflick" → Continue → Create project
//  3. On the project overview, click the </> (Web) icon
//     → App nickname: "pickflick" → Register app → Continue to console
//  4. In the left sidebar: Build → Realtime Database → Create Database
//     → Choose a region (e.g. us-central1) → Start in TEST MODE → Enable
//  5. In Realtime Database, click the "Rules" tab and paste this, then Publish:
//
//       {
//         "rules": {
//           "sessions": {
//             "$code": {
//               ".read": true,
//               ".write": true
//             }
//           }
//         }
//       }
//
//  6. In the left sidebar: Project Settings (gear icon) → General
//     Scroll to "Your apps" → copy the firebaseConfig values below
//
// ============================================================

export const firebaseConfig = {
  apiKey:            "YOUR_API_KEY",
  authDomain:        "YOUR_PROJECT_ID.firebaseapp.com",
  databaseURL:       "https://YOUR_PROJECT_ID-default-rtdb.firebaseio.com",
  projectId:         "YOUR_PROJECT_ID",
  storageBucket:     "YOUR_PROJECT_ID.appspot.com",
  messagingSenderId: "YOUR_MESSAGING_SENDER_ID",
  appId:             "YOUR_APP_ID"
};
