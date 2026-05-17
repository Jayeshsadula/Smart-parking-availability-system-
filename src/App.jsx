import { useState, useEffect, useCallback } from "react";
import { auth, db as firestoreDb } from "./firebase/config";
import { 
  createUserWithEmailAndPassword, 
  signInWithEmailAndPassword, 
  signOut, 
  onAuthStateChanged 
} from "firebase/auth";
import { 
  doc, 
  setDoc, 
  getDoc,
  collection, 
  onSnapshot, 
  updateDoc,
  query,
  where
} from "firebase/firestore";

// ─── Firebase Config (real config loaded from config.js) ───────────────────────


// ─── Simulated Data Store (replaces Firestore in demo) ──────────────────────
const ZONES = ["A", "B", "C", "D"];
const SLOTS_PER_ZONE = 6;

const generateSlots = () => {
  const slots = [];
  ZONES.forEach((zone) => {
    for (let i = 1; i <= SLOTS_PER_ZONE; i++) {
      slots.push({
        slotId: `${zone}${i}`,
        zone,
        level: "L1",
        isPhysicallyOccupied: Math.random() > 0.6,
      });
    }
  });
  return slots;
};

let mockSlots = generateSlots();
let mockBookings = [];
let mockUser = null;
let liveListeners = [];
let isFirestoreActive = false;

const saveUserBookings = (userId, list) => {
  if (!userId) return;
  try {
    localStorage.setItem(`parksmart_bookings_${userId}`, JSON.stringify(list));
  } catch (e) {
    console.error("Error saving user bookings to localStorage:", e);
  }
};

const loadUserBookings = (userId) => {
  if (!userId) return [];
  try {
    const cached = localStorage.getItem(`parksmart_bookings_${userId}`);
    return cached ? JSON.parse(cached) : [];
  } catch (e) {
    console.error("Error loading user bookings from localStorage:", e);
    return [];
  }
};

const getBookingStatus = (b) => {
  if (b.status === "cancelled") return "cancelled";
  if (b.status === "completed") return "completed";
  
  const now = new Date();
  const [year, month, day] = b.date.split("-").map(Number);
  const [hours, minutes] = b.endTime.split(":").map(Number);
  const bookingEndDate = new Date(year, month - 1, day, hours, minutes, 0);
  
  if (now > bookingEndDate) {
    // 1. Proactively update in Firestore in the background
    updateDoc(doc(firestoreDb, "bookings", b.bookingId), { status: "completed" })
      .catch((err) => console.error("Error healing booking status in Firestore:", err));
      
    // 2. Self-heal in local RAM and localStorage cache immediately to guarantee offline persistence!
    const idx = mockBookings.findIndex((item) => item.bookingId === b.bookingId);
    if (idx !== -1 && mockBookings[idx].status !== "completed") {
      mockBookings[idx].status = "completed";
      saveUserBookings(b.userId, mockBookings);
    }
    
    return "completed";
  }
  return "active";
};

const db = {
  getSlots: () => [...mockSlots],
  getBookings: (userId) => mockBookings.filter((b) => b.userId === userId),
  getAllBookings: () => [...mockBookings],
  addBooking: async (booking) => {
    // Optimistic write: save locally first to guarantee zero-latency UI reactivity and offline persistence
    mockBookings = mockBookings.filter((b) => b.bookingId !== booking.bookingId);
    mockBookings.push(booking);
    saveUserBookings(booking.userId, mockBookings);
    liveListeners.forEach((cb) => cb([...mockSlots]));

    try {
      await setDoc(doc(firestoreDb, "bookings", booking.bookingId), booking);
    } catch (err) {
      console.error("Firestore addBooking error, fell back to local storage cache:", err);
    }
    return booking;
  },
  cancelBooking: async (bookingId) => {
    // Optimistic write: cancel locally first to ensure instant visual feedback
    const idx = mockBookings.findIndex((b) => b.bookingId === bookingId);
    if (idx !== -1) {
      mockBookings[idx].status = "cancelled";
      saveUserBookings(mockUser?.userId || "", mockBookings);
      liveListeners.forEach((cb) => cb([...mockSlots]));
    }

    try {
      await updateDoc(doc(firestoreDb, "bookings", bookingId), { status: "cancelled" });
    } catch (err) {
      console.error("Firestore cancelBooking error, fell back to local storage cache:", err);
    }
  },

  updateLiveStatus: async (slotId, isOccupied) => {
    if (isFirestoreActive) {
      try {
        await setDoc(doc(firestoreDb, "live_status", slotId), {
          slotId,
          isPhysicallyOccupied: isOccupied,
          lastUpdated: new Date().toISOString()
        }, { merge: true });
      } catch (err) {
        console.error("Firestore updateLiveStatus error:", err);
      }
    } else {
      const slot = mockSlots.find((s) => s.slotId === slotId);
      if (slot) slot.isPhysicallyOccupied = isOccupied;
      liveListeners.forEach((cb) => cb([...mockSlots]));
    }
  },
  onLiveStatus: (cb) => {
    liveListeners.push(cb);
    cb([...mockSlots]);
    return () => {
      liveListeners = liveListeners.filter((l) => l !== cb);
    };
  },
};

// ─── Simulator ───────────────────────────────────────────────────────────────
const startSimulator = () => {
  return setInterval(() => {
    if (isFirestoreActive) return; // Skip if Firestore is active and syncing
    const randomSlot = mockSlots[Math.floor(Math.random() * mockSlots.length)];
    db.updateLiveStatus(randomSlot.slotId, !randomSlot.isPhysicallyOccupied);
  }, 3000);
};


// ─── QR Code Generator (canvas-based) ────────────────────────────────────────
const generateQR = (text, canvas) => {
  if (!canvas) return;
  const size = canvas.width;
  const ctx = canvas.getContext("2d");
  ctx.fillStyle = "#0f172a";
  ctx.fillRect(0, 0, size, size);
  // Simple visual pattern (in production use qrcode library)
  const cellSize = size / 21;
  const pattern = [];
  for (let i = 0; i < 441; i++) {
    pattern.push(Math.random() > 0.5 ? 1 : 0);
  }
  // Fixed corners (finder patterns)
  const setBlock = (row, col, val) => {
    if (row >= 0 && row < 21 && col >= 0 && col < 21)
      pattern[row * 21 + col] = val;
  };
  for (let r = 0; r < 7; r++)
    for (let c = 0; c < 7; c++) {
      const v =
        r === 0 || r === 6 || c === 0 || c === 6 || (r >= 2 && r <= 4 && c >= 2 && c <= 4) ? 1 : 0;
      setBlock(r, c, v);
      setBlock(r, 14 + c, v);
      setBlock(14 + r, c, v);
    }
  ctx.fillStyle = "#00d4ff";
  pattern.forEach((bit, i) => {
    if (bit) {
      const row = Math.floor(i / 21);
      const col = i % 21;
      ctx.fillRect(col * cellSize + 2, row * cellSize + 2, cellSize - 1, cellSize - 1);
    }
  });
};

// ─── Utilities ────────────────────────────────────────────────────────────────
const genId = () => Math.random().toString(36).substr(2, 9).toUpperCase();
const timeOverlap = (s1, e1, s2, e2) => s1 < e2 && e1 > s2;
const toMin = (t) => {
  const [h, m] = t.split(":").map(Number);
  return h * 60 + m;
};

// ─── Styles ───────────────────────────────────────────────────────────────────
const S = {
  app: {
    minHeight: "100vh",
    background: "#060d1f",
    color: "#e2e8f0",
    fontFamily: "'Rajdhani', 'Orbitron', monospace",
  },
  nav: {
    background: "rgba(6,13,31,0.95)",
    borderBottom: "1px solid rgba(0,212,255,0.2)",
    padding: "0 2rem",
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    height: 64,
    position: "sticky",
    top: 0,
    zIndex: 100,
    backdropFilter: "blur(12px)",
  },
  logo: {
    fontSize: 22,
    fontWeight: 700,
    color: "#00d4ff",
    letterSpacing: 2,
    display: "flex",
    alignItems: "center",
    gap: 8,
  },
  btn: {
    background: "linear-gradient(135deg, #00d4ff, #0066ff)",
    color: "#fff",
    border: "none",
    padding: "10px 24px",
    borderRadius: 8,
    cursor: "pointer",
    fontWeight: 600,
    fontSize: 14,
    letterSpacing: 1,
    transition: "all 0.2s",
  },
  btnOutline: {
    background: "transparent",
    color: "#00d4ff",
    border: "1px solid #00d4ff",
    padding: "10px 24px",
    borderRadius: 8,
    cursor: "pointer",
    fontWeight: 600,
    fontSize: 14,
    letterSpacing: 1,
    transition: "all 0.2s",
  },
  btnDanger: {
    background: "linear-gradient(135deg, #ff4466, #cc0033)",
    color: "#fff",
    border: "none",
    padding: "8px 18px",
    borderRadius: 8,
    cursor: "pointer",
    fontWeight: 600,
    fontSize: 13,
  },
  card: {
    background: "rgba(15,23,42,0.8)",
    border: "1px solid rgba(0,212,255,0.15)",
    borderRadius: 16,
    padding: "1.5rem",
  },
  input: {
    background: "rgba(255,255,255,0.05)",
    border: "1px solid rgba(0,212,255,0.3)",
    borderRadius: 8,
    color: "#e2e8f0",
    padding: "12px 16px",
    width: "100%",
    fontSize: 14,
    outline: "none",
    boxSizing: "border-box",
  },
  label: { fontSize: 12, color: "#94a3b8", letterSpacing: 1, marginBottom: 6, display: "block" },
  page: { padding: "2rem", maxWidth: 1200, margin: "0 auto" },
  grid2: { display: "grid", gridTemplateColumns: "1fr 1fr", gap: "1.5rem" },
  grid3: { display: "grid", gridTemplateColumns: "repeat(3,1fr)", gap: "1.5rem" },
  grid4: { display: "grid", gridTemplateColumns: "repeat(4,1fr)", gap: "1.5rem" },
  statCard: {
    background: "rgba(0,212,255,0.05)",
    border: "1px solid rgba(0,212,255,0.2)",
    borderRadius: 12,
    padding: "1.25rem",
    textAlign: "center",
  },
  tag: (color) => ({
    display: "inline-block",
    padding: "3px 10px",
    borderRadius: 20,
    fontSize: 11,
    fontWeight: 700,
    letterSpacing: 1,
    background:
      color === "green"
        ? "rgba(0,255,128,0.15)"
        : color === "red"
        ? "rgba(255,50,80,0.15)"
        : color === "blue"
        ? "rgba(0,150,255,0.15)"
        : "rgba(150,150,150,0.15)",
    color:
      color === "green"
        ? "#00ff80"
        : color === "red"
        ? "#ff3250"
        : color === "blue"
        ? "#0099ff"
        : "#888",
  }),
};

// ─── Notification Toast ───────────────────────────────────────────────────────
const Toast = ({ msg, onClose }) => (
  <div
    style={{
      position: "fixed",
      bottom: 24,
      right: 24,
      background: "linear-gradient(135deg,#00d4ff22,#0066ff22)",
      border: "1px solid #00d4ff66",
      borderRadius: 12,
      padding: "14px 20px",
      color: "#00d4ff",
      fontWeight: 600,
      zIndex: 9999,
      maxWidth: 320,
      fontSize: 14,
    }}
  >
    ✓ {msg}
    <button
      onClick={onClose}
      style={{ marginLeft: 16, background: "none", border: "none", color: "#00d4ff", cursor: "pointer", fontSize: 16 }}
    >
      ×
    </button>
  </div>
);

// ─── Promise Timeout Helper ───────────────────────────────────────────────────
const withTimeout = (promise, ms = 1500) => {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error("Firestore connection timeout"));
    }, ms);
    promise
      .then((res) => {
        clearTimeout(timer);
        resolve(res);
      })
      .catch((err) => {
        clearTimeout(timer);
        reject(err);
      });
  });
};

// ─── Main App ─────────────────────────────────────────────────────────────────
export default function App() {
  const [page, setPage] = useState("landing");
  const [user, setUser] = useState(null);
  const [toast, setToast] = useState(null);
  const [simulatorId, setSimulatorId] = useState(null);

  const notify = (msg) => {
    setToast(msg);
    setTimeout(() => setToast(null), 4000);
  };

  const nav = (p) => setPage(p);

  useEffect(() => {
    const id = startSimulator();
    setSimulatorId(id);
    return () => clearInterval(id);
  }, []);

  useEffect(() => {
    let unsubSlots = () => {};

    try {
      unsubSlots = onSnapshot(collection(firestoreDb, "live_status"), (snap) => {
        if (!snap.empty) {
          isFirestoreActive = true;
        }
        const liveList = [];
        snap.forEach((doc) => {
          liveList.push(doc.data());
        });
        
        // Merge with mockSlots
        mockSlots = mockSlots.map((slot) => {
          const live = liveList.find((l) => l.slotId === slot.slotId);
          return {
            ...slot,
            isPhysicallyOccupied: live ? live.isPhysicallyOccupied : slot.isPhysicallyOccupied
          };
        });
        
        // Notify components
        liveListeners.forEach((cb) => cb([...mockSlots]));
      }, (err) => {
        console.error("Firestore live_status listener error:", err);
      });
    } catch (err) {
      console.error("Failed to setup live_status listener:", err);
    }

    return () => {
      unsubSlots();
    };
  }, []);

  useEffect(() => {
    let unsubBookings = () => {};

    const unsubAuth = onAuthStateChanged(auth, async (firebaseUser) => {
      unsubBookings(); // Clean up previous bookings listener

      if (firebaseUser) {
        // 1. Immediately load local storage cached bookings for this specific user (guarantees offline persistence works instantly!)
        const localCached = loadUserBookings(firebaseUser.uid);
        mockBookings = localCached;
        liveListeners.forEach((cb) => cb([...mockSlots]));

        // 2. Resilient Live Sync: Subscribe to Firestore bookings
        unsubBookings = onSnapshot(
          collection(firestoreDb, "bookings"),
          (snap) => {
            isFirestoreActive = true;
            const bookingsList = [];
            snap.forEach((doc) => {
              bookingsList.push(doc.data());
            });
            mockBookings = bookingsList;
            saveUserBookings(firebaseUser.uid, bookingsList);
            liveListeners.forEach((cb) => cb([...mockSlots]));
          },
          (err) => {
            console.warn("Unable to query all bookings (due to strict security rules). Falling back to user-specific bookings listener...", err);
            
            // Safe Fallback: Subscribe ONLY to the logged-in user's bookings (fully permitted under strict rules)
            unsubBookings();
            unsubBookings = onSnapshot(
              query(collection(firestoreDb, "bookings"), where("userId", "==", firebaseUser.uid)),
              (snap) => {
                isFirestoreActive = true;
                const bookingsList = [];
                snap.forEach((doc) => {
                  bookingsList.push(doc.data());
                });
                mockBookings = bookingsList;
                saveUserBookings(firebaseUser.uid, bookingsList);
                liveListeners.forEach((cb) => cb([...mockSlots]));
              },
              (fallbackErr) => {
                console.error("Firestore user bookings listener error:", fallbackErr);
              }
            );
          }
        );

        // 3. Fetch User Profile Doc asynchronously, with quick fallback so it never blocks UI transitions
        try {
          const docRef = doc(firestoreDb, "users", firebaseUser.uid);
          const docSnap = await withTimeout(getDoc(docRef), 1500);
          let profile = { name: firebaseUser.email.split("@")[0], vehicleNumber: "TS09AB1234" };
          if (docSnap.exists()) {
            profile = docSnap.data();
          }
          const u = {
            userId: firebaseUser.uid,
            name: profile.name || firebaseUser.email.split("@")[0],
            email: firebaseUser.email,
            vehicleNumber: profile.vehicleNumber || "TS09AB1234",
          };
          setUser(u);
          mockUser = u;
          setPage("dashboard");
        } catch (err) {
          console.error("Error fetching user profile:", err);
          const u = {
            userId: firebaseUser.uid,
            name: firebaseUser.email.split("@")[0],
            email: firebaseUser.email,
            vehicleNumber: "TS09AB1234",
          };
          setUser(u);
          mockUser = u;
          setPage("dashboard");
        }
      } else {
        setUser(null);
        mockUser = null;
        setPage("landing");
        mockBookings = []; // Reset local cache on logout
        liveListeners.forEach((cb) => cb([...mockSlots]));
      }
    });

    return () => {
      unsubAuth();
      unsubBookings();
    };
  }, []);


  const logout = async () => {
    try {
      await signOut(auth);
      notify("Logged out successfully!");
    } catch (err) {
      console.error(err);
      notify("Failed to log out");
    }
  };

  return (
    <div style={S.app}>
      <link
        href="https://fonts.googleapis.com/css2?family=Orbitron:wght@400;700;900&family=Rajdhani:wght@400;500;600;700&display=swap"
        rel="stylesheet"
      />
      {user && (
        <nav style={S.nav}>
          <div style={S.logo}>
            <span style={{ fontSize: 28 }}>⬡</span> ParkSmart AI
          </div>
          <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
            {[
              ["dashboard", "Dashboard"],
              ["book", "Book Slot"],
              ["live", "Live Monitor"],
              ["bookings", "My Bookings"],
            ].map(([p, label]) => (
              <button
                key={p}
                onClick={() => nav(p)}
                style={{
                  background: page === p ? "rgba(0,212,255,0.15)" : "transparent",
                  color: page === p ? "#00d4ff" : "#94a3b8",
                  border: page === p ? "1px solid rgba(0,212,255,0.4)" : "1px solid transparent",
                  padding: "8px 16px",
                  borderRadius: 8,
                  cursor: "pointer",
                  fontSize: 13,
                  fontWeight: 600,
                  letterSpacing: 0.5,
                  transition: "all 0.2s",
                }}
              >
                {label}
              </button>
            ))}
            <div style={{ width: 1, height: 24, background: "rgba(0,212,255,0.2)", margin: "0 8px" }} />
            <span style={{ fontSize: 13, color: "#94a3b8" }}>{user.name}</span>
            <button onClick={logout} style={{ ...S.btnOutline, padding: "6px 14px", fontSize: 12 }}>
              Logout
            </button>
          </div>
        </nav>
      )}

      {page === "landing" && <LandingPage nav={nav} />}
      {page === "login" && <LoginPage nav={nav} notify={notify} />}
      {page === "signup" && <SignupPage nav={nav} notify={notify} />}
      {page === "dashboard" && user && <Dashboard user={user} nav={nav} />}
      {page === "book" && user && <BookingPage user={user} nav={nav} notify={notify} />}
      {page === "live" && <LiveMonitor />}
      {page === "bookings" && user && <MyBookings user={user} notify={notify} nav={nav} />}
      {page === "navigate" && user && <NavigationPage user={user} nav={nav} />}

      {toast && <Toast msg={toast} onClose={() => setToast(null)} />}
    </div>
  );
}

// ─── Landing Page ─────────────────────────────────────────────────────────────
function LandingPage({ nav }) {
  return (
    <div>
      {/* Hero */}
      <div
        style={{
          minHeight: "100vh",
          background: "radial-gradient(ellipse 80% 60% at 50% 0%, rgba(0,100,255,0.15) 0%, transparent 70%)",
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          justifyContent: "center",
          padding: "4rem 2rem",
          textAlign: "center",
          position: "relative",
          overflow: "hidden",
        }}
      >
        {/* Grid background */}
        <div
          style={{
            position: "absolute",
            inset: 0,
            backgroundImage:
              "linear-gradient(rgba(0,212,255,0.05) 1px, transparent 1px), linear-gradient(90deg, rgba(0,212,255,0.05) 1px, transparent 1px)",
            backgroundSize: "60px 60px",
            pointerEvents: "none",
          }}
        />

        {/* Logo */}
        <div style={{ fontSize: 64, marginBottom: 8 }}>⬡</div>
        <h1
          style={{
            fontSize: "clamp(3rem, 8vw, 6rem)",
            fontFamily: "'Orbitron', monospace",
            fontWeight: 900,
            background: "linear-gradient(135deg, #00d4ff, #0066ff, #7c3aed)",
            WebkitBackgroundClip: "text",
            WebkitTextFillColor: "transparent",
            margin: "0 0 1rem",
            letterSpacing: 4,
          }}
        >
          ParkSmart AI
        </h1>
        <p style={{ fontSize: "clamp(1.1rem, 3vw, 1.6rem)", color: "#94a3b8", marginBottom: "3rem", letterSpacing: 2 }}>
          Book Smarter. Park Faster.
        </p>

        {/* Animated parking lot */}
        <ParkingLotIllustration />

        <div style={{ display: "flex", gap: 16, marginTop: "3rem", flexWrap: "wrap", justifyContent: "center" }}>
          <button onClick={() => nav("login")} style={{ ...S.btn, padding: "14px 36px", fontSize: 16 }}>
            Login
          </button>
          <button onClick={() => nav("signup")} style={{ ...S.btnOutline, padding: "14px 36px", fontSize: 16 }}>
            Sign Up
          </button>
          <button
            onClick={() => nav("live")}
            style={{ ...S.btnOutline, padding: "14px 36px", fontSize: 16, borderColor: "#7c3aed", color: "#a78bfa" }}
          >
            View Live Parking →
          </button>
        </div>

        {/* Features */}
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))", gap: "1.5rem", marginTop: "5rem", width: "100%", maxWidth: 900 }}>
          {[
            { icon: "🎯", title: "Smart Booking", desc: "Reserve your spot in seconds with conflict prevention" },
            { icon: "📡", title: "Live Monitoring", desc: "Real-time occupancy updates every 3 seconds" },
            { icon: "📱", title: "QR Tickets", desc: "Digital tickets with unique QR codes for entry" },
            { icon: "🧭", title: "Navigation", desc: "Step-by-step guidance to your reserved slot" },
          ].map((f) => (
            <div key={f.title} style={{ ...S.card, textAlign: "center" }}>
              <div style={{ fontSize: 36, marginBottom: 12 }}>{f.icon}</div>
              <div style={{ fontWeight: 700, fontSize: 16, color: "#00d4ff", marginBottom: 8 }}>{f.title}</div>
              <div style={{ fontSize: 13, color: "#64748b", lineHeight: 1.6 }}>{f.desc}</div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

function ParkingLotIllustration() {
  const [occupied, setOccupied] = useState(() =>
    Array.from({ length: 12 }, () => Math.random() > 0.5)
  );

  useEffect(() => {
    const iv = setInterval(() => {
      setOccupied((prev) => {
        const next = [...prev];
        const idx = Math.floor(Math.random() * next.length);
        next[idx] = !next[idx];
        return next;
      });
    }, 1500);
    return () => clearInterval(iv);
  }, []);

  return (
    <div style={{ display: "flex", gap: 4, flexWrap: "wrap", justifyContent: "center", maxWidth: 380 }}>
      {occupied.map((occ, i) => (
        <div
          key={i}
          style={{
            width: 52,
            height: 72,
            borderRadius: 6,
            background: occ ? "rgba(255,50,80,0.3)" : "rgba(0,255,128,0.2)",
            border: `1px solid ${occ ? "#ff3250" : "#00ff80"}`,
            transition: "all 0.5s ease",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            fontSize: 22,
            position: "relative",
            overflow: "hidden",
          }}
        >
          {occ ? "🚗" : ""}
          {!occ && (
            <div
              style={{
                position: "absolute",
                bottom: 4,
                left: "50%",
                transform: "translateX(-50%)",
                width: 20,
                height: 1,
                background: "rgba(0,255,128,0.4)",
              }}
            />
          )}
        </div>
      ))}
    </div>
  );
}

// ─── Login Page ───────────────────────────────────────────────────────────────
function LoginPage({ nav, notify }) {
  const [form, setForm] = useState({ email: "", password: "" });
  const [loading, setLoading] = useState(false);

  const submit = async () => {
    if (!form.email || !form.password) return notify("Fill all fields");
    setLoading(true);
    try {
      await signInWithEmailAndPassword(auth, form.email, form.password);
      notify("Logged in successfully!");
    } catch (err) {
      console.error(err);
      let errorMsg = "Invalid email or password";
      if (err.code === "auth/invalid-email") errorMsg = "Invalid email address format";
      if (err.code === "auth/user-not-found" || err.code === "auth/wrong-password") errorMsg = "Incorrect email or password";
      if (err.code === "auth/invalid-credential") errorMsg = "Incorrect email or password";
      if (err.code === "auth/configuration-not-found") {
        errorMsg = "⚠️ Email/Password Auth is disabled in your Firebase console. Please enable it under Build -> Authentication -> Sign-in Method.";
      }
      notify(errorMsg);
    } finally {
      setLoading(false);
    }
  };

  return (
    <AuthLayout title="Welcome Back" subtitle="Sign in to ParkSmart AI">
      <div style={{ marginBottom: 16 }}>
        <label style={S.label}>EMAIL ADDRESS</label>
        <input style={S.input} type="email" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} placeholder="you@example.com" disabled={loading} />
      </div>
      <div style={{ marginBottom: 24 }}>
        <label style={S.label}>PASSWORD</label>
        <input style={S.input} type="password" value={form.password} onChange={(e) => setForm({ ...form, password: e.target.value })} placeholder="••••••••" disabled={loading} />
      </div>
      <button onClick={submit} style={{ ...S.btn, width: "100%", padding: 14 }} disabled={loading}>
        {loading ? "Signing In..." : "Sign In"}
      </button>
      <p style={{ textAlign: "center", marginTop: 16, color: "#64748b", fontSize: 13 }}>
        No account?{" "}
        <span onClick={() => nav("signup")} style={{ color: "#00d4ff", cursor: "pointer" }}>
          Sign Up
        </span>
      </p>
    </AuthLayout>
  );
}

// ─── Signup Page ──────────────────────────────────────────────────────────────
function SignupPage({ nav, notify }) {
  const [form, setForm] = useState({ name: "", email: "", vehicle: "", password: "" });
  const [loading, setLoading] = useState(false);

  const submit = async () => {
    if (!form.name || !form.email || !form.vehicle || !form.password) return notify("Fill all fields");
    setLoading(true);
    try {
      const userCredential = await createUserWithEmailAndPassword(auth, form.email, form.password);
      const firebaseUser = userCredential.user;
      
      const profileData = {
        userId: firebaseUser.uid,
        name: form.name,
        email: form.email,
        vehicleNumber: form.vehicle,
      };
      await withTimeout(setDoc(doc(firestoreDb, "users", firebaseUser.uid), profileData), 1500);
      notify("Account created successfully!");
    } catch (err) {
      console.error(err);
      let errorMsg = err.message || "Failed to create account";
      if (err.code === "auth/email-already-in-use") errorMsg = "Email is already registered";
      if (err.code === "auth/invalid-email") errorMsg = "Invalid email address format";
      if (err.code === "auth/weak-password") errorMsg = "Password should be at least 6 characters";
      if (err.code === "auth/configuration-not-found") {
        errorMsg = "⚠️ Email/Password Auth is disabled in your Firebase console. Please enable it under Build -> Authentication -> Sign-in Method.";
      }
      notify(errorMsg);
    } finally {
      setLoading(false);
    }
  };

  return (
    <AuthLayout title="Create Account" subtitle="Join ParkSmart AI today">
      {[
        { key: "name", label: "FULL NAME", type: "text", ph: "John Doe" },
        { key: "email", label: "EMAIL ADDRESS", type: "email", ph: "you@example.com" },
        { key: "vehicle", label: "VEHICLE NUMBER", type: "text", ph: "TS09AB1234" },
        { key: "password", label: "PASSWORD", type: "password", ph: "••••••••" },
      ].map(({ key, label, type, ph }) => (
        <div key={key} style={{ marginBottom: 16 }}>
          <label style={S.label}>{label}</label>
          <input style={S.input} type={type} value={form[key]} onChange={(e) => setForm({ ...form, [key]: e.target.value })} placeholder={ph} disabled={loading} />
        </div>
      ))}
      <button onClick={submit} style={{ ...S.btn, width: "100%", padding: 14 }} disabled={loading}>
        {loading ? "Creating Account..." : "Create Account"}
      </button>
      <p style={{ textAlign: "center", marginTop: 16, color: "#64748b", fontSize: 13 }}>
        Have an account?{" "}
        <span onClick={() => nav("login")} style={{ color: "#00d4ff", cursor: "pointer" }}>
          Sign In
        </span>
      </p>
    </AuthLayout>
  );
}

function AuthLayout({ title, subtitle, children }) {
  return (
    <div
      style={{
        minHeight: "100vh",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        background: "radial-gradient(ellipse 60% 60% at 50% 50%, rgba(0,100,255,0.1) 0%, transparent 70%)",
        padding: "2rem",
      }}
    >
      <div style={{ ...S.card, width: "100%", maxWidth: 420 }}>
        <div style={{ textAlign: "center", marginBottom: "2rem" }}>
          <div style={{ fontSize: 40, marginBottom: 8 }}>⬡</div>
          <h2 style={{ fontSize: 24, fontFamily: "'Orbitron',monospace", color: "#00d4ff", margin: "0 0 8px" }}>{title}</h2>
          <p style={{ color: "#64748b", fontSize: 13 }}>{subtitle}</p>
        </div>
        {children}
      </div>
    </div>
  );
}

// ─── Dashboard ────────────────────────────────────────────────────────────────
function Dashboard({ user, nav }) {
  const [slots, setSlots] = useState(db.getSlots());
  const [bookings, setBookings] = useState(db.getBookings(user.userId));

  useEffect(() => {
    const unsub = db.onLiveStatus((s) => {
      setSlots(s);
      setBookings(db.getBookings(user.userId));
    });
    return unsub;
  }, [user.userId]);

  const total = slots.length;
  const occupied = slots.filter((s) => s.isPhysicallyOccupied).length;
  const available = total - occupied;
  const activeBookings = bookings.filter((b) => getBookingStatus(b) === "active").length;

  const stats = [
    { label: "Total Slots", value: total, color: "#00d4ff" },
    { label: "Available", value: available, color: "#00ff80" },
    { label: "Occupied", value: occupied, color: "#ff3250" },
    { label: "My Bookings", value: activeBookings, color: "#a78bfa" },
  ];

  return (
    <div style={S.page}>
      <div style={{ marginBottom: "2rem" }}>
        <h1 style={{ fontSize: 28, fontFamily: "'Orbitron',monospace", color: "#00d4ff", margin: "0 0 4px" }}>
          Dashboard
        </h1>
        <p style={{ color: "#64748b", fontSize: 14 }}>Welcome back, {user.name} · {user.vehicleNumber}</p>
      </div>

      {/* Stats */}
      <div style={{ ...S.grid4, marginBottom: "2rem" }}>
        {stats.map((s) => (
          <div key={s.label} style={{ ...S.statCard, borderColor: `${s.color}33` }}>
            <div style={{ fontSize: 36, fontFamily: "'Orbitron',monospace", fontWeight: 700, color: s.color }}>
              {s.value}
            </div>
            <div style={{ fontSize: 12, color: "#64748b", letterSpacing: 1, marginTop: 4 }}>{s.label}</div>
          </div>
        ))}
      </div>

      {/* Quick Actions */}
      <div style={{ ...S.card, marginBottom: "2rem" }}>
        <h3 style={{ fontSize: 14, letterSpacing: 2, color: "#64748b", margin: "0 0 1rem" }}>QUICK ACTIONS</h3>
        <div style={{ display: "flex", gap: 12, flexWrap: "wrap" }}>
          <button onClick={() => nav("book")} style={S.btn}>🎯 Book a Slot</button>
          <button onClick={() => nav("live")} style={{ ...S.btnOutline, borderColor: "#a78bfa", color: "#a78bfa" }}>📡 Live Monitor</button>
          <button onClick={() => nav("bookings")} style={{ ...S.btnOutline }}>📋 My Bookings</button>
          <button onClick={() => nav("navigate")} style={{ ...S.btnOutline, borderColor: "#fbbf24", color: "#fbbf24" }}>🧭 Navigation</button>
        </div>
      </div>

      {/* Mini grid preview */}
      <div style={S.card}>
        <h3 style={{ fontSize: 14, letterSpacing: 2, color: "#64748b", margin: "0 0 1rem" }}>
          LIVE OVERVIEW <span style={{ ...S.tag("green"), marginLeft: 8 }}>● LIVE</span>
        </h3>
        <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
          {slots.map((slot) => (
            <div
              key={slot.slotId}
              title={slot.slotId}
              style={{
                width: 44,
                height: 56,
                borderRadius: 6,
                background: slot.isPhysicallyOccupied ? "rgba(255,50,80,0.2)" : "rgba(0,255,128,0.15)",
                border: `1px solid ${slot.isPhysicallyOccupied ? "#ff3250" : "#00ff80"}`,
                display: "flex",
                flexDirection: "column",
                alignItems: "center",
                justifyContent: "center",
                fontSize: 10,
                color: slot.isPhysicallyOccupied ? "#ff3250" : "#00ff80",
                fontWeight: 700,
                transition: "all 0.4s",
                cursor: "pointer",
              }}
              onClick={() => nav("live")}
            >
              {slot.slotId}
              <span style={{ fontSize: 16 }}>{slot.isPhysicallyOccupied ? "🚗" : ""}</span>
            </div>
          ))}
        </div>
        <div style={{ marginTop: 12, display: "flex", gap: 16, fontSize: 12, color: "#64748b" }}>
          <span>🟢 Available</span>
          <span>🔴 Occupied</span>
        </div>
      </div>
    </div>
  );
}

// ─── Booking Page ─────────────────────────────────────────────────────────────
function BookingPage({ user, nav, notify }) {
  // Get exact local date (accounting for timezone offset) instead of UTC date
  const getLocalDateString = () => {
    const d = new Date();
    const pad = (num) => String(num).padStart(2, "0");
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  };

  const today = getLocalDateString();
  const [date, setDate] = useState(today);

  // Smart defaults based on current local hours
  const getSmartDefaultTimes = () => {
    const now = new Date();
    let startHour = now.getHours() + 1;
    let endHour = startHour + 2;
    
    if (startHour > 23) {
      startHour = 23;
      endHour = 23;
    }
    if (endHour > 23) {
      endHour = 23;
    }
    
    const pad = (num) => String(num).padStart(2, "0");
    return {
      start: `${pad(startHour)}:00`,
      end: `${pad(endHour)}:00`
    };
  };

  const defaults = getSmartDefaultTimes();
  const [startTime, setStartTime] = useState(defaults.start);
  const [endTime, setEndTime] = useState(defaults.end);
  const [selected, setSelected] = useState(null);
  const [slots, setSlots] = useState(db.getSlots());
  const [confirmed, setConfirmed] = useState(null);

  useEffect(() => {
    const unsub = db.onLiveStatus(setSlots);
    return unsub;
  }, []);

  const isBooked = (slotId) => {
    return db.getAllBookings().some(
      (b) =>
        b.slotId === slotId &&
        b.date === date &&
        getBookingStatus(b) === "active" &&
        timeOverlap(toMin(startTime), toMin(endTime), toMin(b.startTime), toMin(b.endTime))
    );
  };

  const getSlotStatus = (slot) => {
    if (slot.isPhysicallyOccupied) return "occupied";
    if (isBooked(slot.slotId)) return "booked";
    if (selected === slot.slotId) return "selected";
    return "available";
  };

  const slotColor = { available: "#00ff80", booked: "#888", occupied: "#ff3250", selected: "#00d4ff" };
  const slotBg = { available: "rgba(0,255,128,0.1)", booked: "rgba(100,100,100,0.15)", occupied: "rgba(255,50,80,0.15)", selected: "rgba(0,212,255,0.2)" };

  const confirm = () => {
    if (!selected) return notify("Select a slot first");
    
    // Validate booking time is strictly in the future
    const now = new Date();
    const [year, month, day] = date.split("-").map(Number);
    const [startHours, startMinutes] = startTime.split(":").map(Number);
    const [endHours, endMinutes] = endTime.split(":").map(Number);
    
    const bookingStartDate = new Date(year, month - 1, day, startHours, startMinutes, 0);
    const bookingEndDate = new Date(year, month - 1, day, endHours, endMinutes, 0);
    
    if (now > bookingEndDate) {
      return notify("⚠️ Cannot book a slot in the past!");
    }
    
    if (bookingStartDate >= bookingEndDate) {
      return notify("⚠️ End time must be after start time!");
    }

    const booking = {
      bookingId: `PS-${genId()}`,
      userId: user.userId,
      slotId: selected,
      date,
      startTime,
      endTime,
      status: "active",
      vehicleNumber: user.vehicleNumber,
      userName: user.name,
    };
    db.addBooking(booking);
    setConfirmed(booking);
    notify(`Slot ${selected} booked successfully!`);
  };


  if (confirmed) return <ConfirmationPage booking={confirmed} nav={nav} onBack={() => setConfirmed(null)} />;

  return (
    <div style={S.page}>
      <div style={{ marginBottom: "2rem" }}>
        <h1 style={{ fontSize: 28, fontFamily: "'Orbitron',monospace", color: "#00d4ff", margin: 0 }}>Book a Slot</h1>
        <p style={{ color: "#64748b", fontSize: 14 }}>Select your date, time, and parking spot</p>
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "1fr 340px", gap: "2rem", alignItems: "start" }}>
        <div>
          {/* Date/Time Picker */}
          <div style={{ ...S.card, marginBottom: "1.5rem" }}>
            <h3 style={{ fontSize: 13, letterSpacing: 2, color: "#64748b", margin: "0 0 1rem" }}>SELECT DATE & TIME</h3>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 12 }}>
              <div>
                <label style={S.label}>DATE</label>
                <input style={S.input} type="date" value={date} min={today} onChange={(e) => setDate(e.target.value)} />
              </div>
              <div>
                <label style={S.label}>START TIME</label>
                <input style={S.input} type="time" value={startTime} onChange={(e) => setStartTime(e.target.value)} />
              </div>
              <div>
                <label style={S.label}>END TIME</label>
                <input style={S.input} type="time" value={endTime} onChange={(e) => setEndTime(e.target.value)} />
              </div>
            </div>
          </div>

          {/* Slot Grid */}
          <div style={S.card}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "1.5rem" }}>
              <h3 style={{ fontSize: 13, letterSpacing: 2, color: "#64748b", margin: 0 }}>SELECT PARKING SLOT</h3>
              <div style={{ display: "flex", gap: 12, fontSize: 11 }}>
                {[["available", "#00ff80", "Available"], ["selected", "#00d4ff", "Selected"], ["booked", "#888", "Booked"], ["occupied", "#ff3250", "Occupied"]].map(([k, c, l]) => (
                  <span key={k} style={{ color: "#64748b" }}>
                    <span style={{ color: c }}>■</span> {l}
                  </span>
                ))}
              </div>
            </div>

            {/* Entrance indicator */}
            <div style={{ textAlign: "center", marginBottom: "1rem" }}>
              <div style={{ display: "inline-block", background: "rgba(251,191,36,0.1)", border: "1px solid #fbbf24", borderRadius: 6, padding: "4px 20px", fontSize: 11, color: "#fbbf24", letterSpacing: 2 }}>
                ▲ ENTRANCE
              </div>
            </div>

            {ZONES.map((zone) => (
              <div key={zone} style={{ marginBottom: 16 }}>
                <div style={{ fontSize: 11, color: "#64748b", letterSpacing: 2, marginBottom: 8 }}>ZONE {zone}</div>
                <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
                  {/* Left side */}
                  <div style={{ display: "flex", gap: 6 }}>
                    {slots.filter((s) => s.zone === zone && parseInt(s.slotId.slice(1)) <= 3).map((slot) => {
                      const status = getSlotStatus(slot);
                      return (
                        <div
                          key={slot.slotId}
                          onClick={() => status === "available" && setSelected(slot.slotId)}
                          style={{
                            width: 64,
                            height: 80,
                            borderRadius: 8,
                            background: slotBg[status],
                            border: `1px solid ${slotColor[status]}`,
                            display: "flex",
                            flexDirection: "column",
                            alignItems: "center",
                            justifyContent: "center",
                            cursor: status === "available" ? "pointer" : "not-allowed",
                            transition: "all 0.3s",
                            opacity: status === "booked" ? 0.5 : 1,
                          }}
                        >
                          <span style={{ fontSize: 11, fontWeight: 700, color: slotColor[status] }}>{slot.slotId}</span>
                          {status === "occupied" && <span style={{ fontSize: 18 }}>🚗</span>}
                          {status === "selected" && <span style={{ fontSize: 18 }}>✓</span>}
                        </div>
                      );
                    })}
                  </div>
                  {/* Driveway */}
                  <div style={{ flex: 1, textAlign: "center", fontSize: 10, color: "#334155", letterSpacing: 2, borderTop: "2px dashed rgba(51,65,85,0.5)", position: "relative" }}>
                    <span style={{ position: "absolute", top: -10, left: "50%", transform: "translateX(-50%)", background: "#060d1f", padding: "0 8px" }}>DRIVE</span>
                  </div>
                  {/* Right side */}
                  <div style={{ display: "flex", gap: 6 }}>
                    {slots.filter((s) => s.zone === zone && parseInt(s.slotId.slice(1)) > 3).map((slot) => {
                      const status = getSlotStatus(slot);
                      return (
                        <div
                          key={slot.slotId}
                          onClick={() => status === "available" && setSelected(slot.slotId)}
                          style={{
                            width: 64,
                            height: 80,
                            borderRadius: 8,
                            background: slotBg[status],
                            border: `1px solid ${slotColor[status]}`,
                            display: "flex",
                            flexDirection: "column",
                            alignItems: "center",
                            justifyContent: "center",
                            cursor: status === "available" ? "pointer" : "not-allowed",
                            transition: "all 0.3s",
                            opacity: status === "booked" ? 0.5 : 1,
                          }}
                        >
                          <span style={{ fontSize: 11, fontWeight: 700, color: slotColor[status] }}>{slot.slotId}</span>
                          {status === "occupied" && <span style={{ fontSize: 18 }}>🚗</span>}
                          {status === "selected" && <span style={{ fontSize: 18 }}>✓</span>}
                        </div>
                      );
                    })}
                  </div>
                </div>
              </div>
            ))}
          </div>
        </div>

        {/* Booking Summary */}
        <div style={{ ...S.card, position: "sticky", top: 80 }}>
          <h3 style={{ fontSize: 13, letterSpacing: 2, color: "#64748b", margin: "0 0 1.5rem" }}>BOOKING SUMMARY</h3>
          {[
            ["Slot", selected || "Not selected"],
            ["Date", date],
            ["Start", startTime],
            ["End", endTime],
            ["Vehicle", user.vehicleNumber],
            ["Driver", user.name],
          ].map(([k, v]) => (
            <div key={k} style={{ display: "flex", justifyContent: "space-between", marginBottom: 12, fontSize: 13 }}>
              <span style={{ color: "#64748b" }}>{k}</span>
              <span style={{ color: selected || k !== "Slot" ? "#e2e8f0" : "#475569", fontWeight: 600 }}>{v}</span>
            </div>
          ))}
          <div style={{ borderTop: "1px solid rgba(0,212,255,0.1)", marginTop: 16, paddingTop: 16 }}>
            <div style={{ display: "flex", justifyContent: "space-between", fontSize: 13, marginBottom: 16 }}>
              <span style={{ color: "#64748b" }}>Duration</span>
              <span style={{ color: "#00ff80", fontWeight: 700 }}>
                {Math.max(0, toMin(endTime) - toMin(startTime))} min
              </span>
            </div>
            <button
              onClick={confirm}
              style={{ ...S.btn, width: "100%", padding: 14, opacity: selected ? 1 : 0.5 }}
              disabled={!selected}
            >
              Confirm Booking
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

// ─── Confirmation Page ────────────────────────────────────────────────────────
function ConfirmationPage({ booking, nav, onBack }) {
  const canvasRef = useCallback((canvas) => {
    if (canvas) generateQR(booking.bookingId, canvas);
  }, [booking.bookingId]);

  return (
    <div style={S.page}>
      <div style={{ maxWidth: 600, margin: "0 auto" }}>
        <div style={{ textAlign: "center", marginBottom: "2rem" }}>
          <div style={{ fontSize: 64, marginBottom: 12 }}>✅</div>
          <h1 style={{ fontSize: 24, fontFamily: "'Orbitron',monospace", color: "#00ff80", margin: "0 0 8px" }}>
            Booking Confirmed!
          </h1>
          <p style={{ color: "#64748b" }}>Your parking slot is reserved</p>
        </div>

        <div style={S.card}>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 160px", gap: "2rem", alignItems: "center" }}>
            <div>
              {[
                ["Booking ID", booking.bookingId],
                ["Slot", booking.slotId],
                ["Date", booking.date],
                ["Time", `${booking.startTime} – ${booking.endTime}`],
                ["Vehicle", booking.vehicleNumber],
                ["Status", "ACTIVE"],
              ].map(([k, v]) => (
                <div key={k} style={{ display: "flex", justifyContent: "space-between", marginBottom: 12, fontSize: 13 }}>
                  <span style={{ color: "#64748b" }}>{k}</span>
                  <span style={{ fontWeight: 700, color: k === "Status" ? "#00ff80" : "#e2e8f0" }}>{v}</span>
                </div>
              ))}
            </div>
            <div style={{ textAlign: "center" }}>
              <canvas ref={canvasRef} width={140} height={140} style={{ borderRadius: 8, border: "1px solid rgba(0,212,255,0.3)" }} />
              <div style={{ fontSize: 10, color: "#64748b", marginTop: 4 }}>SCAN TO ENTER</div>
            </div>
          </div>

          <div style={{ marginTop: "1.5rem", padding: "1rem", background: "rgba(0,212,255,0.05)", borderRadius: 8, fontSize: 13, color: "#94a3b8" }}>
            <strong style={{ color: "#00d4ff" }}>📍 Parking Instructions:</strong>
            <br />Enter via Main Gate → Follow signs to Zone {booking.slotId[0]} → Proceed to Slot {booking.slotId}
          </div>
        </div>

        <div style={{ display: "flex", gap: 12, marginTop: "1.5rem" }}>
          <button onClick={() => nav("navigate")} style={{ ...S.btn, flex: 1 }}>🧭 Get Navigation</button>
          <button onClick={() => nav("bookings")} style={{ ...S.btnOutline, flex: 1 }}>📋 My Bookings</button>
        </div>
      </div>
    </div>
  );
}

// ─── Live Monitor ─────────────────────────────────────────────────────────────
function LiveMonitor() {
  const [slots, setSlots] = useState(db.getSlots());
  const [lastUpdate, setLastUpdate] = useState(new Date());
  const [pulse, setPulse] = useState(false);

  useEffect(() => {
    const unsub = db.onLiveStatus((s) => {
      setSlots(s);
      setLastUpdate(new Date());
      setPulse(true);
      setTimeout(() => setPulse(false), 500);
    });
    return unsub;
  }, []);

  const occupied = slots.filter((s) => s.isPhysicallyOccupied).length;
  const available = slots.length - occupied;
  const occupancyPct = Math.round((occupied / slots.length) * 100);

  return (
    <div style={{ ...S.page, maxWidth: 1200 }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: "2rem" }}>
        <div>
          <h1 style={{ fontSize: 28, fontFamily: "'Orbitron',monospace", color: "#00d4ff", margin: "0 0 4px" }}>
            Live Monitor
          </h1>
          <p style={{ color: "#64748b", fontSize: 13 }}>
            Real-time occupancy · Auto-updates every 3s · Last:{" "}
            <span style={{ color: pulse ? "#00ff80" : "#64748b" }}>{lastUpdate.toLocaleTimeString()}</span>
          </p>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 8, ...S.tag("green"), padding: "8px 16px" }}>
          <span style={{ animation: "pulse 1s infinite" }}>●</span> LIVE
        </div>
      </div>

      {/* Stats */}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(4,1fr)", gap: "1rem", marginBottom: "2rem" }}>
        {[
          { label: "Total Slots", value: slots.length, color: "#00d4ff" },
          { label: "Available", value: available, color: "#00ff80" },
          { label: "Occupied", value: occupied, color: "#ff3250" },
          { label: "Occupancy", value: `${occupancyPct}%`, color: occupancyPct > 75 ? "#ff3250" : occupancyPct > 50 ? "#fbbf24" : "#00ff80" },
        ].map((s) => (
          <div key={s.label} style={{ ...S.statCard, borderColor: `${s.color}33`, transition: "all 0.4s" }}>
            <div style={{ fontSize: 32, fontFamily: "'Orbitron',monospace", fontWeight: 700, color: s.color, transition: "all 0.4s" }}>
              {s.value}
            </div>
            <div style={{ fontSize: 11, color: "#64748b", letterSpacing: 1, marginTop: 4 }}>{s.label}</div>
          </div>
        ))}
      </div>

      {/* Occupancy Bar */}
      <div style={{ ...S.card, marginBottom: "2rem" }}>
        <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 8, fontSize: 12, color: "#64748b" }}>
          <span>OCCUPANCY RATE</span>
          <span style={{ color: occupancyPct > 75 ? "#ff3250" : "#00ff80", fontWeight: 700 }}>{occupancyPct}%</span>
        </div>
        <div style={{ height: 10, background: "rgba(255,255,255,0.05)", borderRadius: 999, overflow: "hidden" }}>
          <div
            style={{
              height: "100%",
              width: `${occupancyPct}%`,
              background: occupancyPct > 75 ? "linear-gradient(90deg,#ff3250,#ff6680)" : occupancyPct > 50 ? "linear-gradient(90deg,#fbbf24,#f59e0b)" : "linear-gradient(90deg,#00ff80,#00d4ff)",
              borderRadius: 999,
              transition: "all 0.8s ease",
            }}
          />
        </div>
      </div>

      {/* Full Grid */}
      <div style={S.card}>
        <h3 style={{ fontSize: 13, letterSpacing: 2, color: "#64748b", margin: "0 0 1.5rem" }}>PARKING LOT LAYOUT</h3>
        {ZONES.map((zone) => (
          <div key={zone} style={{ marginBottom: 24 }}>
            <div style={{ fontSize: 11, letterSpacing: 2, color: "#475569", marginBottom: 10 }}>ZONE {zone}</div>
            <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
              <div style={{ display: "flex", gap: 8 }}>
                {slots.filter((s) => s.zone === zone && parseInt(s.slotId.slice(1)) <= 3).map((slot) => (
                  <SlotCard key={slot.slotId} slot={slot} />
                ))}
              </div>
              <div style={{ flex: 1, borderTop: "2px dashed rgba(51,65,85,0.8)", position: "relative" }}>
                <span
                  style={{ position: "absolute", top: -10, left: "50%", transform: "translateX(-50%)", background: "#060d1f", padding: "0 8px", fontSize: 10, color: "#334155", letterSpacing: 2 }}
                >
                  DRIVEWAY
                </span>
              </div>
              <div style={{ display: "flex", gap: 8 }}>
                {slots.filter((s) => s.zone === zone && parseInt(s.slotId.slice(1)) > 3).map((slot) => (
                  <SlotCard key={slot.slotId} slot={slot} />
                ))}
              </div>
            </div>
          </div>
        ))}
        <div style={{ display: "flex", gap: 20, fontSize: 12, color: "#64748b", marginTop: 8, paddingTop: 16, borderTop: "1px solid rgba(0,212,255,0.08)" }}>
          <span><span style={{ color: "#00ff80" }}>■</span> Vacant</span>
          <span><span style={{ color: "#ff3250" }}>■</span> Occupied</span>
        </div>
      </div>
    </div>
  );
}

function SlotCard({ slot }) {
  return (
    <div
      style={{
        width: 70,
        height: 88,
        borderRadius: 8,
        background: slot.isPhysicallyOccupied ? "rgba(255,50,80,0.15)" : "rgba(0,255,128,0.1)",
        border: `1px solid ${slot.isPhysicallyOccupied ? "#ff3250" : "#00ff80"}`,
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        gap: 4,
        transition: "all 0.4s ease",
      }}
    >
      <span style={{ fontSize: 11, fontWeight: 700, color: slot.isPhysicallyOccupied ? "#ff3250" : "#00ff80" }}>
        {slot.slotId}
      </span>
      <span style={{ fontSize: 22 }}>{slot.isPhysicallyOccupied ? "🚗" : ""}</span>
      <span style={{ fontSize: 9, color: slot.isPhysicallyOccupied ? "#ff3250" : "#00ff80", letterSpacing: 1 }}>
        {slot.isPhysicallyOccupied ? "OCCUPIED" : "VACANT"}
      </span>
    </div>
  );
}

// ─── My Bookings ──────────────────────────────────────────────────────────────
function MyBookings({ user, notify, nav }) {
  const [bookings, setBookings] = useState(db.getBookings(user.userId));
  const [filter, setFilter] = useState("all");
  const [search, setSearch] = useState("");
  const [qrBooking, setQrBooking] = useState(null);

  useEffect(() => {
    const unsub = db.onLiveStatus(() => {
      setBookings(db.getBookings(user.userId));
    });
    return unsub;
  }, [user.userId]);

  const refresh = () => setBookings(db.getBookings(user.userId));

  const cancel = (id) => {
    db.cancelBooking(id);
    refresh();
    notify("Booking cancelled");
  };

  const filtered = bookings
    .filter((b) => {
      const computedStatus = getBookingStatus(b);
      if (filter === "all") return true;
      return computedStatus === filter;
    })
    .filter((b) => !search || b.slotId.includes(search.toUpperCase()) || b.bookingId.includes(search.toUpperCase()) || b.date.includes(search));

  const getStatusColor = (status) => {
    if (status === "active") return "green";
    if (status === "completed") return "blue";
    return "grey";
  };

  return (
    <div style={S.page}>
      <div style={{ marginBottom: "2rem" }}>
        <h1 style={{ fontSize: 28, fontFamily: "'Orbitron',monospace", color: "#00d4ff", margin: "0 0 4px" }}>My Bookings</h1>
        <p style={{ color: "#64748b", fontSize: 14 }}>{bookings.length} total bookings</p>
      </div>

      {/* Filter bar */}
      <div style={{ display: "flex", gap: 12, marginBottom: "1.5rem", flexWrap: "wrap" }}>
        <input
          style={{ ...S.input, maxWidth: 240 }}
          placeholder="Search by slot, date, ID..."
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
        {["all", "active", "completed", "cancelled"].map((f) => (
          <button
            key={f}
            onClick={() => setFilter(f)}
            style={{
              ...filter === f ? S.btn : S.btnOutline,
              padding: "10px 18px",
              fontSize: 12,
              textTransform: "uppercase",
              letterSpacing: 1,
            }}
          >
            {f}
          </button>
        ))}
      </div>

      {filtered.length === 0 ? (
        <div style={{ ...S.card, textAlign: "center", padding: "3rem" }}>
          <div style={{ fontSize: 48, marginBottom: 12 }}>🅿️</div>
          <div style={{ color: "#64748b" }}>No bookings found</div>
          <button onClick={() => nav("book")} style={{ ...S.btn, marginTop: 16 }}>Book Your First Slot</button>
        </div>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: "1rem" }}>
          {filtered.map((b) => (
            <div key={b.bookingId} style={{ ...S.card, display: "grid", gridTemplateColumns: "1fr auto", alignItems: "center", gap: "1.5rem" }}>
              <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(120px, 1fr))", gap: 16 }}>
                <div>
                  <div style={S.label}>BOOKING ID</div>
                  <div style={{ fontSize: 13, fontWeight: 700, color: "#00d4ff" }}>{b.bookingId}</div>
                </div>
                <div>
                  <div style={S.label}>SLOT</div>
                  <div style={{ fontSize: 20, fontWeight: 700, color: "#e2e8f0" }}>{b.slotId}</div>
                </div>
                <div>
                  <div style={S.label}>DATE</div>
                  <div style={{ fontSize: 13 }}>{b.date}</div>
                </div>
                <div>
                  <div style={S.label}>TIME</div>
                  <div style={{ fontSize: 13 }}>{b.startTime} – {b.endTime}</div>
                </div>
                <div>
                  <div style={S.label}>STATUS</div>
                  <span style={S.tag(getStatusColor(getBookingStatus(b)))}>{getBookingStatus(b).toUpperCase()}</span>
                </div>
              </div>
              <div style={{ display: "flex", gap: 8 }}>
                <button onClick={() => setQrBooking(qrBooking?.bookingId === b.bookingId ? null : b)} style={{ ...S.btnOutline, padding: "8px 14px", fontSize: 12 }}>
                  {qrBooking?.bookingId === b.bookingId ? "Hide QR" : "QR Code"}
                </button>
                {getBookingStatus(b) === "active" && (
                  <button onClick={() => cancel(b.bookingId)} style={{ ...S.btnDanger, fontSize: 12 }}>Cancel</button>
                )}
              </div>
            </div>
          ))}
        </div>
      )}


      {/* QR Modal */}
      {qrBooking && (
        <div
          style={{ position: "fixed", inset: 0, background: "rgba(6,13,31,0.85)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 1000 }}
          onClick={() => setQrBooking(null)}
        >
          <div style={{ ...S.card, width: 300, textAlign: "center" }} onClick={(e) => e.stopPropagation()}>
            <h3 style={{ color: "#00d4ff", margin: "0 0 1rem" }}>📱 QR Ticket</h3>
            <canvas
              ref={(c) => c && generateQR(qrBooking.bookingId, c)}
              width={220}
              height={220}
              style={{ borderRadius: 8, border: "1px solid rgba(0,212,255,0.3)" }}
            />
            <div style={{ marginTop: 12, fontSize: 12, color: "#94a3b8" }}>
              <div style={{ fontWeight: 700, color: "#e2e8f0" }}>{qrBooking.bookingId}</div>
              <div>Slot {qrBooking.slotId} · {qrBooking.date}</div>
              <div>{qrBooking.startTime} – {qrBooking.endTime}</div>
            </div>
            <button onClick={() => setQrBooking(null)} style={{ ...S.btnOutline, width: "100%", marginTop: 16, fontSize: 12 }}>Close</button>
          </div>
        </div>
      )}
    </div>
  );
}

// ─── Navigation Page ──────────────────────────────────────────────────────────
function NavigationPage({ user, nav }) {
  const bookings = db.getBookings(user.userId).filter((b) => getBookingStatus(b) === "active");
  const activeBooking = bookings[0];
  const [step, setStep] = useState(0);

  const steps = activeBooking
    ? [
        { icon: "🚘", text: "Arrive at Main Entrance on MG Road", done: step > 0 },
        { icon: "🎫", text: "Scan QR code at entry gate barrier", done: step > 1 },
        { icon: "⬆️", text: `Proceed to Level 1 — Zone ${activeBooking.slotId[0]}`, done: step > 2 },
        { icon: "➡️", text: `Follow aisle to Row ${activeBooking.slotId[0]}`, done: step > 3 },
        { icon: "🅿️", text: `Park in Slot ${activeBooking.slotId} (marked in Blue)`, done: step > 4 },
      ]
    : [];

  return (
    <div style={S.page}>
      <div style={{ maxWidth: 700, margin: "0 auto" }}>
        <div style={{ marginBottom: "2rem" }}>
          <h1 style={{ fontSize: 28, fontFamily: "'Orbitron',monospace", color: "#00d4ff", margin: "0 0 4px" }}>
            Navigation
          </h1>
          <p style={{ color: "#64748b", fontSize: 14 }}>Step-by-step parking guidance</p>
        </div>

        {!activeBooking ? (
          <div style={{ ...S.card, textAlign: "center", padding: "3rem" }}>
            <div style={{ fontSize: 48, marginBottom: 12 }}>🧭</div>
            <div style={{ color: "#64748b", marginBottom: 16 }}>No active bookings for navigation</div>
            <button onClick={() => nav("book")} style={S.btn}>Book a Slot First</button>
          </div>
        ) : (
          <>
            {/* Mini Map */}
            <div style={{ ...S.card, marginBottom: "1.5rem" }}>
              <h3 style={{ fontSize: 13, letterSpacing: 2, color: "#64748b", margin: "0 0 1rem" }}>PARKING MAP</h3>
              <div style={{ position: "relative", background: "rgba(0,0,0,0.3)", borderRadius: 12, padding: "1rem", overflow: "hidden" }}>
                {/* Entrance */}
                <div style={{ textAlign: "center", marginBottom: 16 }}>
                  <div style={{ display: "inline-block", background: "#fbbf2422", border: "1px solid #fbbf24", borderRadius: 6, padding: "6px 20px", fontSize: 12, color: "#fbbf24" }}>
                    ▼ MAIN ENTRANCE
                  </div>
                </div>
                {ZONES.map((zone) => (
                  <div key={zone} style={{ display: "flex", gap: 6, marginBottom: 10, justifyContent: "center", alignItems: "center" }}>
                    {db.getSlots().filter((s) => s.zone === zone).map((slot) => {
                      const isTarget = slot.slotId === activeBooking.slotId;
                      return (
                        <div
                          key={slot.slotId}
                          style={{
                            width: 40,
                            height: 50,
                            borderRadius: 6,
                            background: isTarget ? "rgba(0,212,255,0.3)" : "rgba(100,100,100,0.1)",
                            border: `1px solid ${isTarget ? "#00d4ff" : "rgba(100,100,100,0.3)"}`,
                            display: "flex",
                            alignItems: "center",
                            justifyContent: "center",
                            fontSize: 9,
                            color: isTarget ? "#00d4ff" : "#475569",
                            fontWeight: isTarget ? 700 : 400,
                            boxShadow: isTarget ? "0 0 12px rgba(0,212,255,0.5)" : "none",
                            animation: isTarget ? "pulse 2s infinite" : "none",
                          }}
                        >
                          {slot.slotId}
                        </div>
                      );
                    })}
                  </div>
                ))}
                <div style={{ textAlign: "center", color: "#475569", fontSize: 11, letterSpacing: 1, marginTop: 8 }}>
                  🔵 = YOUR SLOT ({activeBooking.slotId})
                </div>
              </div>
            </div>

            {/* Directions */}
            <div style={S.card}>
              <h3 style={{ fontSize: 13, letterSpacing: 2, color: "#64748b", margin: "0 0 1.5rem" }}>
                STEP-BY-STEP DIRECTIONS
              </h3>
              {steps.map((s, i) => (
                <div
                  key={i}
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 16,
                    padding: "12px 0",
                    borderBottom: i < steps.length - 1 ? "1px solid rgba(0,212,255,0.08)" : "none",
                    opacity: i > step ? 0.4 : 1,
                    transition: "all 0.3s",
                  }}
                >
                  <div
                    style={{
                      width: 36,
                      height: 36,
                      borderRadius: "50%",
                      background: i < step ? "rgba(0,255,128,0.2)" : i === step ? "rgba(0,212,255,0.2)" : "rgba(100,100,100,0.1)",
                      border: `1px solid ${i < step ? "#00ff80" : i === step ? "#00d4ff" : "#334155"}`,
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "center",
                      fontSize: 16,
                      flexShrink: 0,
                    }}
                  >
                    {i < step ? "✓" : s.icon}
                  </div>
                  <div style={{ flex: 1, fontSize: 14, color: i === step ? "#e2e8f0" : "#94a3b8" }}>{s.text}</div>
                  {i === step && (
                    <button onClick={() => setStep(step + 1)} style={{ ...S.btn, padding: "6px 14px", fontSize: 11 }}>
                      Done →
                    </button>
                  )}
                </div>
              ))}
              {step >= steps.length && (
                <div style={{ textAlign: "center", padding: "1rem", color: "#00ff80", fontSize: 14, fontWeight: 700 }}>
                  🎉 You've reached your parking slot!
                </div>
              )}
            </div>
          </>
        )}
      </div>

      <style>{`
        @keyframes pulse { 0%,100% { opacity:1; } 50% { opacity:0.5; } }
      `}</style>
    </div>
  );
}
