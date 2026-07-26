import React, { useEffect, useRef, useState } from "react";
import type { SailingMotionVariant } from "./env-waiting-presentation";

interface SailingSceneProps {
  motionVariant: SailingMotionVariant;
}

interface RevertibleAnimation {
  revert: () => unknown;
}

const REDUCED_MOTION_QUERY = "(prefers-reduced-motion: reduce)";

function getInitialReducedMotionPreference(): boolean {
  return typeof window !== "undefined"
    && typeof window.matchMedia === "function"
    && window.matchMedia(REDUCED_MOTION_QUERY).matches;
}

export default function SailingScene({ motionVariant }: SailingSceneProps) {
  const sceneRef = useRef<HTMLDivElement>(null);
  const [prefersReducedMotion, setPrefersReducedMotion] = useState(
    getInitialReducedMotionPreference,
  );

  useEffect(() => {
    if (typeof window === "undefined" || typeof window.matchMedia !== "function") {
      return undefined;
    }

    const mediaQuery = window.matchMedia(REDUCED_MOTION_QUERY);
    const updatePreference = (event: MediaQueryListEvent) => {
      setPrefersReducedMotion(event.matches);
    };

    setPrefersReducedMotion(mediaQuery.matches);
    mediaQuery.addEventListener("change", updatePreference);
    return () => mediaQuery.removeEventListener("change", updatePreference);
  }, []);

  useEffect(() => {
    if (motionVariant === "static" || prefersReducedMotion) {
      return undefined;
    }

    const scene = sceneRef.current;
    if (!scene) return undefined;

    let cancelled = false;
    const animations: RevertibleAnimation[] = [];

    void import("animejs/waapi")
      .then(({ waapi }) => {
        if (cancelled) return;

        const boat = scene.querySelector<HTMLElement>("[data-sailing-boat]");
        const wind = scene.querySelector<SVGGElement>("[data-sailing-wind]");
        const rearWave = scene.querySelector<SVGGElement>("[data-sailing-wave-rear]");
        const frontWave = scene.querySelector<SVGGElement>("[data-sailing-wave-front]");
        if (!boat || !wind || !rearWave || !frontWave) return;

        if (motionVariant === "preparing") {
          animations.push(
            waapi.animate(boat, {
              y: [0, -8],
              rotate: [-0.8, 0.8],
              duration: 2400,
              ease: "inOutSine",
              loop: true,
              alternate: true,
            }),
            waapi.animate(wind, {
              x: [0, 18],
              opacity: [0.3, 0.8],
              duration: 1900,
              ease: "inOutSine",
              loop: true,
              alternate: true,
            }),
            waapi.animate(rearWave, {
              x: [-8, 8],
              duration: 3800,
              ease: "inOutSine",
              loop: true,
              alternate: true,
            }),
            waapi.animate(frontWave, {
              x: [8, -8],
              duration: 3100,
              ease: "inOutSine",
              loop: true,
              alternate: true,
            }),
          );
          return;
        }

        if (motionVariant === "saving") {
          animations.push(
            waapi.animate(boat, {
              y: [0, -5],
              rotate: [-0.45, 0.45],
              duration: 4200,
              ease: "inOutSine",
              loop: true,
              alternate: true,
            }),
            waapi.animate(rearWave, {
              x: [-5, 5],
              duration: 5600,
              ease: "inOutSine",
              loop: true,
              alternate: true,
            }),
            waapi.animate(frontWave, {
              x: [5, -5],
              duration: 4900,
              ease: "inOutSine",
              loop: true,
              alternate: true,
            }),
          );
          return;
        }

        if (motionVariant === "stopping") {
          animations.push(
            waapi.animate(boat, {
              y: [0, -3],
              rotate: [-0.2, 0.2],
              duration: 3600,
              ease: "inOutSine",
              loop: true,
              alternate: true,
            }),
            waapi.animate(frontWave, {
              x: [3, -3],
              duration: 5200,
              ease: "inOutSine",
              loop: true,
              alternate: true,
            }),
          );
          return;
        }

        animations.push(
          waapi.animate(boat, {
            x: [-10, 10],
            duration: 5000,
            ease: "inOutSine",
            loop: true,
            alternate: true,
          }),
          waapi.animate(rearWave, {
            x: [-6, 6],
            duration: 5600,
            ease: "inOutSine",
            loop: true,
            alternate: true,
          }),
          waapi.animate(frontWave, {
            x: [6, -6],
            duration: 4800,
            ease: "inOutSine",
            loop: true,
            alternate: true,
          }),
        );
      })
      .catch((error) => {
        if (!cancelled) {
          console.warn("[tiller] Failed to start the sailing animation:", error);
        }
      });

    return () => {
      cancelled = true;
      for (const animation of animations) {
        try {
          animation.revert();
        } catch {
          // Continue reverting the remaining scene animations.
        }
      }
      animations.length = 0;
    };
  }, [motionVariant, prefersReducedMotion]);

  return (
    <div
      ref={sceneRef}
      aria-hidden="true"
      data-motion-variant={prefersReducedMotion ? "static" : motionVariant}
      data-testid="sailing-scene"
      className="relative aspect-[16/9] w-full max-w-2xl overflow-hidden rounded-2xl border border-kumo-line bg-kumo-info/5"
    >
      <svg
        viewBox="0 0 800 450"
        preserveAspectRatio="none"
        focusable="false"
        className="absolute inset-0 h-full w-full text-kumo-info/20"
      >
        <g data-sailing-wind fill="none" stroke="currentColor" strokeLinecap="round" strokeWidth="5">
          <path d="M90 105c38-24 86-24 124 0" />
          <path d="M58 151c48-30 112-30 160 0" />
          <path d="M124 197c29-17 66-17 95 0" />
        </g>
      </svg>

      <div
        data-sailing-boat
        className="absolute bottom-[13%] left-1/2 z-10 w-[36%] max-w-60 min-w-36 -translate-x-1/2 origin-bottom"
      >
        <img
          src="/jung-rig-rail.svg"
          alt=""
          draggable={false}
          className="tiller-rail-logo h-auto w-full select-none object-contain"
        />
      </div>

      <svg
        viewBox="0 0 800 150"
        preserveAspectRatio="none"
        focusable="false"
        className="absolute inset-x-[-3%] bottom-0 h-[34%] w-[106%] text-kumo-info/25"
      >
        <g data-sailing-wave-rear>
          <path
            fill="currentColor"
            d="M0 64C85 18 150 102 238 58c89-45 150 35 238 2 89-34 154 33 324-5v95H0Z"
          />
        </g>
      </svg>

      <svg
        viewBox="0 0 800 150"
        preserveAspectRatio="none"
        focusable="false"
        className="absolute inset-x-[-3%] bottom-0 z-20 h-[28%] w-[106%] text-kumo-info/45"
      >
        <g data-sailing-wave-front>
          <path
            fill="currentColor"
            d="M0 70c94-46 169 35 260 2 92-33 161 44 253 1 91-43 171 26 287-4v81H0Z"
          />
        </g>
      </svg>
    </div>
  );
}
