import { initializeApp } from "https://www.gstatic.com/firebasejs/10.8.0/firebase-app.js";
import { getFirestore } from "https://www.gstatic.com/firebasejs/10.8.0/firebase-firestore.js";
import { getAuth } from "https://www.gstatic.com/firebasejs/10.8.0/firebase-auth.js";

// ⚠️ ЗАМЕНИТЕ НА ВАШ КОНФИГ ИЗ FIREBASE CONSOLE
const firebaseConfig = {
  apiKey: "AIzaSyAwidQK7IouRYraOmDy3HGIMKUQZc-4-_4",
  authDomain: "tsmap-551ab.firebaseapp.com",
  projectId: "tsmap-551ab",
  storageBucket: "tsmap-551ab.firebasestorage.app",
  messagingSenderId: "737055841603",
  appId: "1:737055841603:web:3a022c72a153e0e97fa3f6"
};

const app = initializeApp(firebaseConfig);
export const db = getFirestore(app);
export const auth = getAuth(app);