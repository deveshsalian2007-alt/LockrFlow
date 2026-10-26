

import { initializeApp } from "https://www.gstatic.com/firebasejs/13.1.0/firebase-app.js";

import {
  getAuth,
  signInWithEmailAndPassword,
  signOut,
  onAuthStateChanged
} from "https://www.gstatic.com/firebasejs/13.1.0/firebase-auth.js";

const firebaseConfig = {
  apiKey: "AIzaSyCfI6BLRaEbPo_PO8m15kRy30tn4CJNbkU",
  authDomain: "lockerflow-b5a0f.firebaseapp.com",
  projectId: "lockerflow-b5a0f",
  storageBucket: "lockerflow-b5a0f.firebasestorage.app",
  messagingSenderId: "658660140356",
  appId: "1:658660140356:web:53b350757e07b9eae2a311",
  measurementId: "G-53ERM4H8RQ"
};

const app = initializeApp(firebaseConfig);
const auth = getAuth(app);

export {
  auth,
  signInWithEmailAndPassword,
  signOut,
  onAuthStateChanged
};
