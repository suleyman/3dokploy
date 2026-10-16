/**
 * Endless floor grid. Lines come from world coordinates in the fragment shader, so there is no
 * edge and no distance fade (an orthographic camera has no horizon to fade into). The plane just
 * follows the orbit target. Fine cells fade out when they get too dense on screen; section lines
 * always stay.
 */
import { useFrame, useThree } from '@react-three/fiber';
import { useMemo, useRef } from 'react';
import * as THREE from 'three';

const SIZE = 6000;

const vertexShader = /* glsl */ `
  varying vec2 vWorld;
  void main() {
    vec4 world = modelMatrix * vec4(position, 1.0);
    vWorld = world.xz;
    gl_Position = projectionMatrix * viewMatrix * world;
  }
`;

const fragmentShader = /* glsl */ `
  uniform vec3 cellColor;
  uniform vec3 sectionColor;
  uniform float cellSize;
  uniform float sectionSize;
  varying vec2 vWorld;

  // 1 on a line, 0 between lines; width in screen pixels via fwidth (anti-aliased at any zoom).
  float lines(vec2 p, float size, float width) {
    vec2 r = p / size;
    vec2 d = abs(fract(r - 0.5) - 0.5) / fwidth(r);
    return 1.0 - min(min(d.x, d.y) / width, 1.0);
  }

  void main() {
    float cell = lines(vWorld, cellSize, 0.9);
    float section = lines(vWorld, sectionSize, 1.3);
    // World units per pixel vs cell size: hide the fine grid before it turns into noise.
    float density = max(fwidth(vWorld.x), fwidth(vWorld.y)) / cellSize;
    float cellFade = 1.0 - smoothstep(0.1, 0.22, density);
    float alpha = max(cell * 0.8 * cellFade, section);
    if (alpha <= 0.002) discard;
    gl_FragColor = vec4(mix(cellColor, sectionColor, section), alpha);
    #include <colorspace_fragment>
  }
`;

interface Props {
  cellSize: number;
  sectionSize: number;
  cellColor: string;
  sectionColor: string;
}

export function InfiniteGrid({ cellSize, sectionSize, cellColor, sectionColor }: Props) {
  const mesh = useRef<THREE.Mesh>(null);
  const controls = useThree((s) => s.controls) as { target?: THREE.Vector3 } | null;
  const material = useMemo(
    () =>
      new THREE.ShaderMaterial({
        vertexShader,
        fragmentShader,
        transparent: true,
        depthWrite: false,
        uniforms: {
          cellColor: { value: new THREE.Color(cellColor) },
          sectionColor: { value: new THREE.Color(sectionColor) },
          cellSize: { value: cellSize },
          sectionSize: { value: sectionSize },
        },
      }),
    [cellColor, sectionColor, cellSize, sectionSize],
  );

  // Keep the (huge) plane centred under the view; snap to sections so nothing shimmers.
  useFrame(() => {
    const t = controls?.target;
    if (!mesh.current || !t) return;
    mesh.current.position.set(Math.round(t.x / sectionSize) * sectionSize, -0.002, Math.round(t.z / sectionSize) * sectionSize);
  });

  return (
    <mesh ref={mesh} rotation-x={-Math.PI / 2} position-y={-0.002} material={material} frustumCulled={false} raycast={() => null}>
      <planeGeometry args={[SIZE, SIZE]} />
    </mesh>
  );
}
