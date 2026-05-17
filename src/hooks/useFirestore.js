// src/hooks/useFirestore.js
import { useState, useEffect } from "react";
import {
  collection,
  onSnapshot,
  query,
  where,
  addDoc,
  updateDoc,
  doc,
  getDocs,
  serverTimestamp,
  runTransaction,
} from "firebase/firestore";
import { db } from "../firebase/config";

// ── Live Parking Status ────────────────────────────────────────────────────────
export function useLiveStatus() {
  const [slots, setSlots] = useState([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const unsub = onSnapshot(collection(db, "live_status"), (snap) => {
      setSlots(snap.docs.map((d) => ({ id: d.id, ...d.data() })));
      setLoading(false);
    });
    return unsub;
  }, []);

  return { slots, loading };
}

// ── User Bookings ──────────────────────────────────────────────────────────────
export function useBookings(userId) {
  const [bookings, setBookings] = useState([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!userId) return;
    const q = query(collection(db, "bookings"), where("userId", "==", userId));
    const unsub = onSnapshot(q, (snap) => {
      setBookings(snap.docs.map((d) => ({ id: d.id, ...d.data() })));
      setLoading(false);
    });
    return unsub;
  }, [userId]);

  return { bookings, loading };
}

// ── Check Slot Availability for Date/Time ─────────────────────────────────────
export async function getBookedSlotsForTime(date, startTime, endTime) {
  const q = query(
    collection(db, "bookings"),
    where("date", "==", date),
    where("status", "==", "active")
  );
  const snap = await getDocs(q);
  const booked = new Set();
  snap.docs.forEach((d) => {
    const b = d.data();
    const toMin = (t) => parseInt(t.split(":")[0]) * 60 + parseInt(t.split(":")[1]);
    if (toMin(startTime) < toMin(b.endTime) && toMin(endTime) > toMin(b.startTime)) {
      booked.add(b.slotId);
    }
  });
  return booked;
}

// ── Create Booking (with conflict prevention transaction) ─────────────────────
export async function createBooking(bookingData) {
  const bookingRef = doc(collection(db, "bookings"));
  await runTransaction(db, async (tx) => {
    // Check for conflicts inside transaction
    const q = query(
      collection(db, "bookings"),
      where("slotId", "==", bookingData.slotId),
      where("date", "==", bookingData.date),
      where("status", "==", "active")
    );
    const snap = await getDocs(q);
    const toMin = (t) => parseInt(t.split(":")[0]) * 60 + parseInt(t.split(":")[1]);
    const conflict = snap.docs.some((d) => {
      const b = d.data();
      return toMin(bookingData.startTime) < toMin(b.endTime) &&
             toMin(bookingData.endTime) > toMin(b.startTime);
    });
    if (conflict) throw new Error("Slot already booked for this time");
    tx.set(bookingRef, { ...bookingData, createdAt: serverTimestamp() });
  });
  return bookingRef.id;
}

// ── Cancel Booking ─────────────────────────────────────────────────────────────
export async function cancelBooking(bookingId) {
  await updateDoc(doc(db, "bookings", bookingId), { status: "cancelled" });
}
