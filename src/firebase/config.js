// src/firebase/config.js
import { initializeApp } from "firebase/app";
import { getAuth } from "firebase/auth";
import { getFirestore } from "firebase/firestore";
import { getAnalytics } from "firebase/analytics";

const getEnv = (key, fallback) => {
  if (typeof import.meta !== "undefined" && import.meta.env && import.meta.env[key]) {
    return import.meta.env[key];
  }
  if (typeof process !== "undefined" && process.env && process.env[key]) {
    return process.env[key];
  }
  return fallback;
};

const firebaseConfig = {
  apiKey: getEnv("VITE_FIREBASE_API_KEY", "AIzaSyAg88qHuGXhJ5PHRr0Afw57zp_3wWj_agI"),
  authDomain: getEnv("VITE_FIREBASE_AUTH_DOMAIN", "parksmart-ai.firebaseapp.com"),
  projectId: getEnv("VITE_FIREBASE_PROJECT_ID", "parksmart-ai"),
  storageBucket: getEnv("VITE_FIREBASE_STORAGE_BUCKET", "parksmart-ai.firebasestorage.app"),
  messagingSenderId: getEnv("VITE_FIREBASE_MESSAGING_SENDER_ID", "368319655965"),
  appId: getEnv("VITE_FIREBASE_APP_ID", "1:368319655965:web:5b3081648d9b8b6b6096f4"),
  measurementId: getEnv("VITE_FIREBASE_MEASUREMENT_ID", "G-ZS0BXZ59ZR")
};

const app = initializeApp(firebaseConfig);
export const auth = getAuth(app);
export const db = getFirestore(app);
export const analytics = getAnalytics(app);
export default app;

