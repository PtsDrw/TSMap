import { db, auth } from './firebase-config.js';
import {
  collection, query, where, getDocs, doc, getDoc
} from "https://www.gstatic.com/firebasejs/10.8.0/firebase-firestore.js";
import {
  signInWithEmailAndPassword, signOut, onAuthStateChanged, signInAnonymously
} from "https://www.gstatic.com/firebasejs/10.8.0/firebase-auth.js";

const SESSION_KEY = 'ts_session';

export function getSession() {
  try { return JSON.parse(localStorage.getItem(SESSION_KEY)); } catch { return null; }
}
export function setSession(s) { localStorage.setItem(SESSION_KEY, JSON.stringify(s)); }
export function clearSession() { localStorage.removeItem(SESSION_KEY); }

export async function loginWithKey(key) {
  // ⭐ Анонимный вход в Firebase (обязательно для правил request.auth != null)
  try {
    if (!auth.currentUser) await signInAnonymously(auth);
  } catch (e) {
    console.warn('Anonymous auth failed (включите в Firebase Console → Authentication):', e.message);
  }

  const q = query(collection(db, 'access_keys'), where('key', '==', key.trim().toUpperCase()));
  const snap = await getDocs(q);
  if (snap.empty) throw new Error('Ключ не найден');

  const d = snap.docs[0];
  const data = d.data();
  if (data.isRevoked) throw new Error('Ключ отозван администратором');

  const session = {
    type: 'manager',
    keyId: d.id,
    key: data.key,
    name: data.name,
    isMainManager: !!data.isMainManager
  };
  setSession(session);
  return session;
}

export async function validateSession() {
  const s = getSession();
  if (!s) return null;
  if (s.type === 'admin') {
    return new Promise(resolve => {
      const unsub = onAuthStateChanged(auth, user => {
        unsub();
        if (user) resolve(s);
        else { clearSession(); resolve(null); }
      });
    });
  }
  if (s.type === 'manager') {
    try {
      const snap = await getDoc(doc(db, 'access_keys', s.keyId));
      if (!snap.exists() || snap.data().isRevoked) { clearSession(); return null; }
      s.isMainManager = !!snap.data().isMainManager;
      s.name = snap.data().name;
      setSession(s);
    } catch (e) {
      console.warn('Session validation failed (возможно, правила Firestore):', e.message);
      // Не выбрасываем — разрешаем работать, если правила блокируют
    }
    return s;
  }
  return null;
}

export async function loginAdmin(email, password) {
  await signInWithEmailAndPassword(auth, email, password);
  const s = { type: 'admin', email };
  setSession(s);
  return s;
}

export async function logout() {
  clearSession();
  try { await signOut(auth); } catch {}
  window.location.href = 'index.html';
}

export function requireAuth(allowedTypes = ['manager', 'admin']) {
  const s = getSession();
  if (!s || !allowedTypes.includes(s.type)) {
    console.warn('requireAuth: редирект на index.html. Сессия:', s);
    window.location.href = 'index.html';
    return null;
  }
  return s;
}