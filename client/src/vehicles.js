// Lightweight Battle Royale rovers. Occupancy is server-owned; the driver uses
// the normal local prediction path, so steering stays immediate on a real network.

import * as THREE from 'three';
import { VEHICLE_HEALTH } from '@shared/constants.js';
import { raycastVehicle } from '@shared/vehicles.js';

function buildRover() {
  const group = new THREE.Group();
  const bodyMat = new THREE.MeshLambertMaterial({ color: 0x274c3d });
  const trimMat = new THREE.MeshLambertMaterial({
    color: 0x45efa8,
    emissive: 0x123c2b,
    emissiveIntensity: 0.55,
  });
  const darkMat = new THREE.MeshLambertMaterial({ color: 0x101713 });
  const glassMat = new THREE.MeshLambertMaterial({
    color: 0x173d39,
    transparent: true,
    opacity: 0.82,
  });

  const chassis = new THREE.Mesh(new THREE.BoxGeometry(1.8, 0.38, 3.05), bodyMat);
  chassis.position.y = 0.48;
  group.add(chassis);

  const nose = new THREE.Mesh(new THREE.BoxGeometry(1.65, 0.26, 1.05), trimMat);
  nose.position.set(0, 0.7, -0.95);
  nose.rotation.x = -0.08;
  group.add(nose);

  const cabin = new THREE.Mesh(new THREE.BoxGeometry(1.45, 0.62, 1.28), glassMat);
  cabin.position.set(0, 0.92, 0.28);
  group.add(cabin);

  const bumper = new THREE.Mesh(new THREE.BoxGeometry(1.95, 0.12, 0.14), trimMat);
  bumper.position.set(0, 0.38, -1.58);
  group.add(bumper);

  const wheelGeo = new THREE.CylinderGeometry(0.43, 0.43, 0.3, 12);
  const wheels = [];
  for (const x of [-1, 1]) {
    for (const z of [-1.02, 1.02]) {
      const wheel = new THREE.Mesh(wheelGeo, darkMat);
      wheel.rotation.z = Math.PI / 2;
      wheel.position.set(x, 0.38, z);
      group.add(wheel);
      wheels.push(wheel);
    }
  }

  for (const x of [-0.58, 0.58]) {
    const lamp = new THREE.Mesh(new THREE.BoxGeometry(0.24, 0.16, 0.06), trimMat);
    lamp.position.set(x, 0.72, -1.51);
    group.add(lamp);
  }

  group.traverse((node) => {
    if (!node.isMesh) return;
    node.castShadow = true;
    node.receiveShadow = true;
  });
  return {
    group,
    wheels,
    materials: [bodyMat, trimMat, darkMat, glassMat],
    lastPos: new THREE.Vector3(),
    targetPos: new THREE.Vector3(),
  };
}

export function createVehicles(scene) {
  return { scene, entries: new Map() };
}

function removeEntry(garage, entry) {
  garage.scene.remove(entry.group);
  const geometries = new Set();
  const materials = new Set();
  entry.group.traverse((node) => {
    if (!node.isMesh) return;
    geometries.add(node.geometry);
    for (const material of Array.isArray(node.material) ? node.material : [node.material]) {
      materials.add(material);
    }
  });
  for (const geometry of geometries) geometry.dispose();
  for (const material of materials) material.dispose();
}

export function clearVehicles(garage) {
  for (const entry of garage.entries.values()) removeEntry(garage, entry);
  garage.entries.clear();
}

export function setVehicles(garage, items, replace = false) {
  if (replace) clearVehicles(garage);
  for (const state of items ?? []) {
    let entry = garage.entries.get(state.i);
    const created = !entry;
    if (!entry) {
      entry = {
        ...buildRover(),
        index: state.i,
        pos: state.p,
        yaw: state.y,
        driverId: state.d,
        health: state.h ?? VEHICLE_HEALTH,
        destroyed: false,
      };
      garage.entries.set(state.i, entry);
      garage.scene.add(entry.group);
    }
    entry.pos = [...state.p];
    entry.yaw = state.y;
    entry.driverId = state.d ?? null;
    entry.health = state.h ?? entry.health ?? VEHICLE_HEALTH;
    entry.targetPos.set(state.p[0], state.p[1], state.p[2]);

    // Initial state needs an immediate position. Subsequent server packets are
    // targets only: snapping here while updateVehicles interpolates every frame
    // made the rover bounce between two competing transforms.
    if (created) {
      entry.group.position.copy(entry.targetPos);
      entry.group.rotation.y = state.y;
      entry.lastPos.copy(entry.group.position);
    }
    if (state.x && !entry.destroyed) markVehicleDestroyed(entry);
  }
}

function markVehicleDestroyed(entry) {
  entry.destroyed = true;
  entry.driverId = null;
  entry.group.rotation.z = 0.055;
  entry.group.scale.y = 0.84;
  for (const material of entry.materials) {
    material.color.multiplyScalar(0.18);
    if (material.emissive) {
      material.emissive.setHex(0x090a09);
      material.emissiveIntensity = 0;
    }
    if ('opacity' in material) material.opacity = Math.min(material.opacity, 0.48);
  }
}

export function vehicleForDriver(garage, playerId) {
  for (const entry of garage.entries.values()) {
    if (entry.driverId === playerId) return entry.index;
  }
  return null;
}

export function nearestVehicle(garage, pos, maxDistance) {
  let best = null;
  for (const entry of garage.entries.values()) {
    if (entry.driverId || entry.destroyed) continue;
    const d = Math.hypot(
      pos[0] - entry.group.position.x,
      pos[1] - entry.group.position.y,
      pos[2] - entry.group.position.z,
    );
    if (d > maxDistance || (best && d >= best.d)) continue;
    best = { index: entry.index, d };
  }
  return best;
}

/** Closest intact rover struck by a world-space ray. */
export function raycastVehicles(garage, origin, direction, maxDistance) {
  let best = null;
  const pos = [0, 0, 0];
  for (const entry of garage.entries.values()) {
    if (entry.destroyed) continue;
    pos[0] = entry.group.position.x;
    pos[1] = entry.group.position.y;
    pos[2] = entry.group.position.z;
    const t = raycastVehicle(origin, direction, pos, entry.group.rotation.y, maxDistance);
    if (t === null || (best && t >= best.t)) continue;
    best = { entry, t };
  }
  return best;
}

export function updateVehicles(garage, dt, states, localPlayer, myId) {
  for (const entry of garage.entries.values()) {
    let pos = entry.pos;
    let yaw = entry.yaw;
    const locallyDriven = !entry.destroyed
      && entry.driverId === myId && localPlayer.vehicleId === entry.index;
    if (locallyDriven) {
      pos = localPlayer.pos;
      yaw = localPlayer.yaw;
    } else if (entry.driverId && !entry.destroyed) {
      const driver = states?.get(entry.driverId);
      if (driver) {
        pos = driver.pos;
        yaw = driver.yaw;
      }
    }

    entry.lastPos.copy(entry.group.position);
    entry.targetPos.set(pos[0], pos[1], pos[2]);
    if (locallyDriven) {
      // Local prediction is already the smooth, freshest answer. Interpolating
      // toward it adds a one-frame rubber band that the chase camera exposes.
      entry.group.position.copy(entry.targetPos);
      entry.group.rotation.y = yaw;
    } else {
      const positionAlpha = 1 - Math.exp(-12 * dt);
      entry.group.position.lerp(entry.targetPos, positionAlpha);
      let diff = yaw - entry.group.rotation.y;
      while (diff > Math.PI) diff -= Math.PI * 2;
      while (diff < -Math.PI) diff += Math.PI * 2;
      entry.group.rotation.y += diff * (1 - Math.exp(-10 * dt));
    }

    const travelled = entry.group.position.distanceTo(entry.lastPos);
    for (const wheel of entry.wheels) wheel.rotation.x -= travelled / 0.43;
  }
}
