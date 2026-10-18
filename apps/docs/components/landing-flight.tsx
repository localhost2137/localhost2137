import { useEffect, useRef, useState } from "react";
import { advanceFlightScene, createFlightScene, resizeFlightScene } from "@/lib/landing-flight";
import { drawFlightScene, type FlightPalette } from "@/lib/landing-flight-renderer";

export function LandingFlight({ theme }: Readonly<{ theme: string | undefined }>) {
	const canvas = useRef<HTMLCanvasElement>(null);
	const scene = useRef(createFlightScene());
	const [paused, setPaused] = useState(false);

	useEffect(() => {
		const element = canvas.current;
		const context = element?.getContext("2d");
		if (!element || !context) return;
		const world = scene.current;
		const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)");
		const palette = getComputedStyle(element);
		const colors: FlightPalette = {
			tower: palette.getPropertyValue("--lp-sky-tower").trim(),
			line: palette.getPropertyValue("--lp-sky-line").trim(),
			cloud: palette.getPropertyValue("--lp-sky-cloud").trim(),
			plane: theme === "dark" ? "#cfcec6" : "#f7f6ef",
			outline: theme === "dark" ? "#747771" : "#747a79",
			wing: theme === "dark" ? "#9a9f9d" : "#bec3c2",
			smoke: theme === "dark" ? "#77746d" : "#676660",
			dust: theme === "dark" ? "#827e71" : "#a5a296",
			scorch: theme === "dark" ? "#12120f" : "#85867d",
		};
		let frame = 0;
		let previous = 0;
		let ratio = 1;

		function paint() {
			if (!context) return;
			context.setTransform(ratio, 0, 0, ratio, 0, 0);
			drawFlightScene(context, world, colors);
		}
		function tick(now: number) {
			advanceFlightScene(world, previous ? (now - previous) / 1000 : 0);
			previous = now;
			paint();
			frame = requestAnimationFrame(tick);
		}
		function syncPlayback() {
			cancelAnimationFrame(frame);
			previous = 0;
			paint();
			if (!paused && !reducedMotion.matches && !document.hidden) {
				frame = requestAnimationFrame(tick);
			}
		}
		const resize = new ResizeObserver(([entry]) => {
			const { width, height } = entry.contentRect;
			resizeFlightScene(world, width, height);
			ratio = Math.min(window.devicePixelRatio || 1, 2);
			element.width = Math.round(width * ratio);
			element.height = Math.round(height * ratio);
			paint();
		});
		// The theme provider can update the root class after React effects have run.
		const themeObserver = new MutationObserver(() => {
			colors.tower = palette.getPropertyValue("--lp-sky-tower").trim();
			colors.line = palette.getPropertyValue("--lp-sky-line").trim();
			colors.cloud = palette.getPropertyValue("--lp-sky-cloud").trim();
			paint();
		});
		themeObserver.observe(document.documentElement, {
			attributes: true,
			attributeFilter: ["class"],
		});
		resize.observe(element);
		syncPlayback();
		reducedMotion.addEventListener("change", syncPlayback);
		document.addEventListener("visibilitychange", syncPlayback);
		return () => {
			cancelAnimationFrame(frame);
			resize.disconnect();
			themeObserver.disconnect();
			reducedMotion.removeEventListener("change", syncPlayback);
			document.removeEventListener("visibilitychange", syncPlayback);
		};
	}, [paused, theme]);

	return (
		<>
			<div className="lp-flight-world" aria-hidden="true">
				<canvas ref={canvas} className="lp-flight-canvas" />
			</div>
			<button
				type="button"
				className="lp-motion-toggle"
				onClick={() => setPaused((value) => !value)}
				aria-label={paused ? "Play background animation" : "Pause background animation"}
				aria-pressed={paused}
			>
				<svg viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
					<path d={paused ? "M5 3 13 8 5 13Z" : "M4 3h3v10H4zM10 3h3v10h-3z"} />
				</svg>
				<span>{paused ? "Play" : "Pause"} animation</span>
			</button>
		</>
	);
}
