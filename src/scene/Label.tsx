/**
 * Minimal screen-space HTML label pinned to a 3D point (a lean stand-in for drei <Html>).
 * - never intercepts pointer events, so orbiting/hovering through labels just works
 * - unmounts its React root after the commit, which avoids React 19's
 *   "synchronously unmount a root while React was already rendering" error
 */
import { useFrame, useThree } from '@react-three/fiber';
import { useLayoutEffect, useRef, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import * as THREE from 'three';

const v = new THREE.Vector3();

interface Props {
  position?: [number, number, number];
  /** 'center' centres the label on the point; 'left' puts its left edge there; 'right' its right edge. */
  anchor?: 'center' | 'left' | 'right';
  zIndex?: number;
  /** Hide while the (orthographic) camera is zoomed out further than this, so far views stay readable. */
  minZoom?: number;
  children: ReactNode;
}

const TRANSFORM = { center: 'translate(-50%, -50%)', left: 'translate(0, -50%)', right: 'translate(-100%, -50%)' };

export function Label({ position = [0, 0, 0], anchor = 'center', zIndex = 1, minZoom = 0, children }: Props) {
  const group = useRef<THREE.Group>(null);
  const gl = useThree((s) => s.gl);
  const host = useRef<{ el: HTMLDivElement; root: Root } | null>(null);

  useLayoutEffect(() => {
    const el = document.createElement('div');
    el.style.cssText = `position:absolute;top:0;left:0;pointer-events:none;z-index:${zIndex};will-change:transform;visibility:hidden;`;
    (gl.domElement.parentNode as HTMLElement).appendChild(el);
    const root = createRoot(el);
    host.current = { el, root };
    return () => {
      host.current = null;
      el.remove();
      setTimeout(() => root.unmount());
    };
  }, [gl, zIndex]);

  useLayoutEffect(() => {
    host.current?.root.render(<div style={{ transform: TRANSFORM[anchor] }}>{children}</div>);
  });

  useFrame(({ camera, size }) => {
    const h = host.current;
    if (!h || !group.current) return;
    group.current.getWorldPosition(v).project(camera);
    const x = Math.round((v.x * 0.5 + 0.5) * size.width);
    const y = Math.round((-v.y * 0.5 + 0.5) * size.height);
    h.el.style.transform = `translate3d(${x}px, ${y}px, 0)`;
    h.el.style.visibility = camera.zoom < minZoom ? 'hidden' : '';
  });

  return <group ref={group} position={position} />;
}
