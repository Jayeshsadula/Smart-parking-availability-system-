"""
ParkSmart AI — Python Simulation Engine
Simulates real-time parking occupancy changes via Firebase Admin SDK.

Usage:
    pip install firebase-admin
    python simulator.py

Setup:
    1. Download your Firebase service account key from:
       Firebase Console → Project Settings → Service Accounts → Generate new private key
    2. Save as 'serviceAccountKey.json' in this directory
    3. Run: python simulator.py
"""

import firebase_admin
from firebase_admin import credentials, firestore
import time
import random
import datetime
import logging
import os

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(message)s",
    datefmt="%H:%M:%S"
)
log = logging.getLogger("ParkSmart Simulator")

# ── Config ─────────────────────────────────────────────────────────────────────
SERVICE_ACCOUNT_PATH = "serviceAccountKey.json"
UPDATE_INTERVAL_SECONDS = 5
ZONES = ["A", "B", "C", "D"]
SLOTS_PER_ZONE = 6
CHANGE_PROBABILITY = 0.25   # 25% chance each slot flips per cycle

# ── Slot IDs ───────────────────────────────────────────────────────────────────
ALL_SLOT_IDS = [f"{zone}{i}" for zone in ZONES for i in range(1, SLOTS_PER_ZONE + 1)]

# ── Firebase Init ──────────────────────────────────────────────────────────────
def init_firebase():
    try:
        if not os.path.exists(SERVICE_ACCOUNT_PATH):
            log.warning("⚠️  'serviceAccountKey.json' not found!")
            log.warning("To connect to your real Firestore database:")
            log.warning("  1. Go to Firebase Console → Project Settings → Service Accounts")
            log.warning("  2. Click 'Generate new private key'")
            log.warning("  3. Save the downloaded JSON file as 'backend/serviceAccountKey.json'")
            log.warning("------------------------------------------------------------------")
            log.warning("Running simulator in DEMO / OFFLINE mode (terminal output only)...")
            log.warning("------------------------------------------------------------------")
            return None
            
        cred = credentials.Certificate(SERVICE_ACCOUNT_PATH)
        firebase_admin.initialize_app(cred)
        db = firestore.client()
        log.info("✅ Firebase connected successfully")
        return db
    except Exception as e:
        log.error(f"❌ Firebase init failed: {e}")
        log.warning("Falling back to DEMO / OFFLINE mode...")
        return None

# ── Seed Initial Data ──────────────────────────────────────────────────────────
def seed_parking_slots(db):
    """Create initial parking_slots and live_status documents."""
    log.info("Seeding parking_slots collection...")
    if db is None:
        log.info("✅ [OFFLINE DEMO] Seeded 24 slots locally.")
        return

    batch = db.batch()

    for slot_id in ALL_SLOT_IDS:
        zone = slot_id[0]
        # parking_slots collection
        slot_ref = db.collection("parking_slots").document(slot_id)
        batch.set(slot_ref, {
            "slotId": slot_id,
            "zone": zone,
            "level": "L1",
            "createdAt": datetime.datetime.utcnow().isoformat()
        }, merge=True)

        # live_status collection
        live_ref = db.collection("live_status").document(slot_id)
        batch.set(live_ref, {
            "slotId": slot_id,
            "isPhysicallyOccupied": random.choice([True, False]),
            "lastUpdated": datetime.datetime.utcnow().isoformat()
        }, merge=True)

    batch.commit()
    log.info(f"✅ Seeded {len(ALL_SLOT_IDS)} slots")

# ── Simulate One Cycle ─────────────────────────────────────────────────────────
def simulate_cycle(db, state: dict) -> dict:
    """
    Randomly flip occupancy for a subset of slots and write to Firestore.
    Returns updated state dict.
    """
    slots_to_update = [s for s in ALL_SLOT_IDS if random.random() < CHANGE_PROBABILITY]

    if not slots_to_update:
        log.info("No changes this cycle")
        return state

    batch = db.batch() if db is not None else None
    changes = []

    for slot_id in slots_to_update:
        new_status = not state.get(slot_id, False)
        state[slot_id] = new_status

        if db is not None:
            live_ref = db.collection("live_status").document(slot_id)
            batch.update(live_ref, {
                "isPhysicallyOccupied": new_status,
                "lastUpdated": datetime.datetime.utcnow().isoformat()
            })
        changes.append(f"{slot_id}→{'🚗 OCCUPIED' if new_status else '✅ VACANT'}")

    if db is not None:
        batch.commit()
    log.info(f"Updated {len(slots_to_update)} slots: {', '.join(changes)}")
    return state

# ── Load Current State ─────────────────────────────────────────────────────────
def load_current_state(db) -> dict:
    """Read current live_status from Firestore."""
    state = {}
    if db is None:
        for slot_id in ALL_SLOT_IDS:
            state[slot_id] = random.choice([True, False])
        return state

    docs = db.collection("live_status").stream()
    for doc in docs:
        data = doc.to_dict()
        state[data["slotId"]] = data.get("isPhysicallyOccupied", False)
    return state

# ── Stats Reporter ─────────────────────────────────────────────────────────────
def print_stats(state: dict):
    occupied = sum(1 for v in state.values() if v)
    vacant = len(state) - occupied
    pct = round((occupied / len(state)) * 100) if state else 0
    bar_len = 20
    filled = round(bar_len * occupied / len(state)) if state else 0
    bar = "█" * filled + "░" * (bar_len - filled)
    log.info(f"Stats │ {bar} │ {occupied}/{len(state)} occupied ({pct}%)")

# ── Main Loop ──────────────────────────────────────────────────────────────────
def main():
    log.info("=" * 50)
    log.info("  ParkSmart AI — Parking Simulator")
    log.info(f"  Zones: {ZONES}  |  Slots: {len(ALL_SLOT_IDS)}")
    log.info(f"  Update interval: {UPDATE_INTERVAL_SECONDS}s")
    log.info("=" * 50)

    db = init_firebase()
    seed_parking_slots(db)

    state = load_current_state(db)
    log.info(f"Loaded state for {len(state)} slots")
    print_stats(state)

    cycle = 0
    try:
        while True:
            cycle += 1
            log.info(f"--- Cycle #{cycle} ---")
            state = simulate_cycle(db, state)
            print_stats(state)
            time.sleep(UPDATE_INTERVAL_SECONDS)
    except KeyboardInterrupt:
        log.info("Simulator stopped by user")


if __name__ == "__main__":
    main()
