/**
 * Moving figures the tour camera can follow (technicians, deploy carts). Each one registers its
 * scene object here while it is mounted; `info` reads its current job without re-rendering.
 * Kept outside the store on purpose: positions change every frame.
 */
import { useEffect, type RefObject } from 'react';
import type * as THREE from 'three';

export interface Actor {
  kind: 'tech' | 'cart';
  obj: RefObject<THREE.Object3D | null>;
  /** What it is doing right now: phase (walk, patrol, inspect, work, home, idle, deploy) and the node it heads for. */
  info: () => { phase: string; target: string | null };
}

export const actors = new Map<string, Actor>();

export function useActor(id: string, actor: Actor) {
  useEffect(() => {
    actors.set(id, actor);
    return () => {
      if (actors.get(id) === actor) actors.delete(id);
    };
  }, [id, actor]);
}
