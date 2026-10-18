import {
	type FlightCorridor,
	physicsStep,
	planFlight,
	stepFlightKinematics,
} from "./landing-flight-controller";

export const flightSpacing = 304;
export const flightSpeed = 128;
export const collapseDuration = 1.85;

export type FlightTrail = { x: number; y: number; time: number };
export type FlightContact = {
	kind: "tower" | "blimp" | "boundary";
	key: string;
	x: number;
	y: number;
	time: number;
};
export type Flyer = {
	id: number;
	position: number;
	size: number;
	y: number;
	velocity: number;
	cooldown: number;
	pitch: number;
	passed: number;
	lastObstacle: number | null;
	attempt: number;
	status: "flying" | "waiting";
	respawnAt: number;
	enteredAt: number;
	nextDecision: number;
	lastContact: FlightContact | null;
	trail: FlightTrail[];
};
export type Tower = {
	key: string;
	index: number;
	side: number;
	x: number;
	roof: number;
	width: number;
};
export type TowerDamage = {
	index: number;
	side: number;
	started: number;
	delay: number;
	hitRatio: number;
	seed: number;
};
export type FlightRect = { x: number; y: number; width: number; height: number };
export type FlightPoint = { x: number; y: number };
export const campaignCandidates = ["trump", "biden", "kennedy", "obama", "bush"] as const;
export type CampaignBlimp = FlightRect & {
	key: string;
	index: number;
	candidate: (typeof campaignCandidates)[number];
	gondola: FlightRect;
	fins: FlightPoint[][];
	engines: FlightRect[];
	damageAge: number | null;
	opacity: number;
};
export type FlightScene = {
	seed: number;
	time: number;
	ticks: number;
	accumulator: number;
	width: number;
	height: number;
	flyers: Flyer[];
	damage: Map<string, TowerDamage>;
	blimpDamage: Map<number, number>;
	stats: { passes: number; crashes: number; hops: number; nearMisses: number; bestStreak: number };
};

export function clamp(value: number, min = 0, max = 1) {
	return Math.min(max, Math.max(min, value));
}

/** Stable variation keeps courses and particles reproducible, including across frame rates. */
export function flightNoise(seed: number) {
	const value = Math.sin(seed * 127.1 + 311.7) * 43758.5453;
	return value - Math.floor(value);
}

export function createFlightScene(seed = 2137): FlightScene {
	return {
		seed,
		time: 0,
		ticks: 0,
		accumulator: 0,
		width: 0,
		height: 0,
		damage: new Map(),
		blimpDamage: new Map(),
		stats: { passes: 0, crashes: 0, hops: 0, nearMisses: 0, bestStreak: 0 },
		flyers: [
			{ position: 0.16, size: 1.8 },
			{ position: 0.82, size: 1.6 },
		].map((flyer, id) => ({
			...flyer,
			id,
			y: 0,
			velocity: 0,
			cooldown: 0,
			pitch: 0,
			passed: 0,
			lastObstacle: null,
			attempt: 0,
			status: "waiting",
			respawnAt: 0,
			enteredAt: -1,
			nextDecision: 0,
			lastContact: null,
			trail: [],
		})),
	};
}

/** Alternating climbs, dives and squeezes, with a recovery gate in each six-gate phrase. */
export function courseGate(index: number, width: number, height: number, seed = 2137) {
	const phase = ((index % 6) + 6) % 6;
	const motif = [0, -0.65, 0.45, -0.35, 0.7, 0.1][phase];
	const amplitude = Math.min(102, height * 0.15);
	const center = height * 0.45 + amplitude * (motif + Math.sin(index * 0.67 + seed) * 0.45);
	const squeeze =
		width < 600
			? 88 + flightNoise(index * 17 + seed) * 32
			: 80 + flightNoise(index * 17 + seed) * 30;
	const gap =
		(phase === 5 ? 164 : phase === 0 ? 136 : squeeze) *
		Math.min(1, height / 580) *
		(width < 600 ? 0.82 : 1);
	const pairWidth = width < 600 ? 76 : 110;
	return { center, gap, pairWidth, roof: center + gap / 2 };
}

export function towerGeometry(index: number, width: number, height: number, seed = 2137): Tower[] {
	const towerWidth = width < 600 ? 32 : 46;
	const separation = width < 600 ? 12 : 18;
	const { roof } = courseGate(index, width, height, seed);
	return [0, 1].map((side) => ({
		key: `${index}:${side}`,
		index,
		side,
		x: index * flightSpacing + side * (towerWidth + separation),
		roof,
		width: towerWidth,
	}));
}

export function collapseProgress(damage: TowerDamage | undefined, time: number) {
	return damage ? clamp((time - damage.started - damage.delay) / collapseDuration) : 0;
}

/** Both the renderer and collision engine consume these same falling floor pieces. */
export function towerStructure(scene: FlightScene, tower: Tower, atTime = scene.time) {
	const floor = scene.height - 45;
	const height = floor - tower.roof;
	const damage = scene.damage.get(tower.key);
	const progress = collapseProgress(damage, atTime);
	const age = damage ? atTime - damage.started : 0;
	const hitY = tower.roof + height * (damage?.hitRatio ?? 0.2);
	const shake = damage && age > damage.delay - 0.35 ? Math.sin(age * 43) * (1 - progress) * 1.4 : 0;
	if (progress === 0)
		return [
			{ x: tower.x + shake, y: tower.roof, width: tower.width, height, antenna: tower.side === 0 },
		];
	const pieces: (FlightRect & { antenna: boolean })[] = [];
	if (progress >= 1) return pieces;
	for (let offset = height - 11; offset >= -11; offset -= 11) {
		const originalY = Math.max(tower.roof, tower.roof + offset);
		const trigger = originalY <= hitY ? 0 : ((originalY - hitY) / (floor - hitY)) * 0.62;
		const fall = clamp((progress - trigger) / (1 - trigger));
		pieces.push({
			x: tower.x + shake + (flightNoise(offset + tower.index * 5) - 0.5) * 18 * fall,
			y: originalY + fall * fall * (floor - originalY - 5),
			width: tower.width,
			height: Math.min(11, floor - originalY) * (1 - fall * 0.85),
			antenna: originalY === tower.roof && tower.side === 0 && fall < 0.75,
		});
	}
	return pieces;
}

export function getBlimp(
	scene: FlightScene,
	index: number,
	atTime = scene.time,
): CampaignBlimp | null {
	const { center, gap, pairWidth } = courseGate(index, scene.width, scene.height, scene.seed);
	const started = scene.blimpDamage.get(index);
	const damageAge = started === undefined ? null : Math.max(0, atTime - started);
	if (damageAge !== null && damageAge >= 3.6) return null;
	const deflation = damageAge === null ? 0 : clamp(damageAge / 3.6);
	const width = scene.width < 600 ? 184 : 236;
	const height = (scene.width < 600 ? 47 : 60) * (1 - deflation * 0.48);
	const phase = flightNoise(index + scene.seed * 3) * Math.PI * 2;
	const bob = Math.sin(atTime * 0.85 + phase) * 12;
	const x = index * flightSpacing + pairWidth / 2 - width / 2 + Math.sin(index * 3.1) * 28;
	const bottom = center - gap / 2 + bob + deflation * deflation * 92;
	const gondola = { x: x + width * 0.3, y: bottom - 11, width: width * 0.23, height: 11 };
	const y = gondola.y - 2 - height;
	const fins = [
		[
			[0.72, 0.34],
			[0.88, -0.19],
			[0.98, -0.19],
			[0.92, 0.46],
		],
		[
			[0.72, 0.66],
			[0.92, 0.54],
			[0.98, 1.19],
			[0.88, 1.19],
		],
		[
			[0.78, 0.48],
			[0.97, 0.32],
			[1, 0.5],
			[0.97, 0.65],
		],
	].map((fin) => fin.map(([px, py]) => ({ x: x + width * px, y: y + height * py })));
	const engines = [0.59, 0.73].map((position) => ({
		x: x + width * position,
		y: y + height * 0.87,
		width: width * 0.08,
		height: 9,
	}));
	// Every five-airship bag includes every candidate once, independently of the course.
	const bag = Math.floor(index / campaignCandidates.length);
	const order = [...campaignCandidates];
	for (let slot = order.length - 1; slot > 0; slot--) {
		const other = Math.floor(flightNoise(bag * 7919 + scene.seed * 23 + slot * 101) * (slot + 1));
		[order[slot], order[other]] = [order[other], order[slot]];
	}
	return {
		key: `blimp:${index}`,
		index,
		candidate: order[((index % order.length) + order.length) % order.length],
		x,
		y,
		width,
		height,
		gondola,
		fins,
		engines,
		damageAge,
		opacity: 1 - clamp((deflation - 0.65) / 0.35),
	};
}

function planeScale(scene: FlightScene, flyer: Flyer) {
	return flyer.size * (scene.width < 600 ? 0.75 : 1);
}

// Exact opaque sprite pieces (local coordinates relative to its rotation origin).
const planeRects = [
	[2, 6, 32, 6],
	[0, 5, 5, 5],
	[2, 0, 3, 7],
	[5, 3, 2, 4],
	[33, 7, 4, 4],
	[36, 8, 2, 2],
	[16, 3, 5, 4],
	[14, 0, 4, 5],
	[16, 10, 5, 4],
	[12, 13, 5, 4],
	[20, 12, 4, 2],
	[21, 3, 4, 2],
];
type Point = FlightPoint;
function aircraftPolygons(scene: FlightScene, flyer: Flyer, atTime: number) {
	const size = planeScale(scene, flyer);
	const c = Math.cos(flyer.pitch) * size;
	const s = Math.sin(flyer.pitch) * size;
	const x = atTime * flightSpeed + scene.width * flyer.position;
	return planeRects.map(([left, top, width, height]) =>
		[
			[left, top],
			[left + width, top],
			[left + width, top + height],
			[left, top + height],
		].map(([px, py]) => ({
			x: x + (px - 19) * c - (py - 8) * s,
			y: flyer.y + (px - 19) * s + (py - 8) * c,
		})),
	);
}

function polygonRect(points: Point[], rect: FlightRect) {
	const corners = [
		{ x: rect.x, y: rect.y },
		{ x: rect.x + rect.width, y: rect.y },
		{ x: rect.x + rect.width, y: rect.y + rect.height },
		{ x: rect.x, y: rect.y + rect.height },
	];
	const axes = [
		{ x: 1, y: 0 },
		{ x: 0, y: 1 },
		{ x: points[1].y - points[0].y, y: points[0].x - points[1].x },
		{ x: points[2].y - points[1].y, y: points[1].x - points[2].x },
	];
	return axes.every((axis) => {
		const a = points.map((p) => p.x * axis.x + p.y * axis.y);
		const b = corners.map((p) => p.x * axis.x + p.y * axis.y);
		return Math.max(...a) >= Math.min(...b) && Math.max(...b) >= Math.min(...a);
	});
}

function polygonPolygon(a: Point[], b: Point[]) {
	return [a, b].every((polygon) =>
		polygon.every((point, index) => {
			const next = polygon[(index + 1) % polygon.length];
			const axis = { x: next.y - point.y, y: point.x - next.x };
			const first = a.map((p) => p.x * axis.x + p.y * axis.y);
			const second = b.map((p) => p.x * axis.x + p.y * axis.y);
			return Math.max(...first) >= Math.min(...second) && Math.max(...second) >= Math.min(...first);
		}),
	);
}

function polygonEllipse(points: Point[], ellipse: FlightRect) {
	const normalized = points.map((p) => ({
		x: (p.x - ellipse.x - ellipse.width / 2) / (ellipse.width / 2),
		y: (p.y - ellipse.y - ellipse.height / 2) / (ellipse.height / 2),
	}));
	if (normalized.some((p) => p.x * p.x + p.y * p.y <= 1)) return true;
	for (let i = 0; i < normalized.length; i++) {
		const a = normalized[i];
		const b = normalized[(i + 1) % normalized.length];
		const dx = b.x - a.x;
		const dy = b.y - a.y;
		const t = clamp(-(a.x * dx + a.y * dy) / (dx * dx + dy * dy));
		if ((a.x + dx * t) ** 2 + (a.y + dy * t) ** 2 <= 1) return true;
	}
	return false;
}

/** Every failure has a contact against the same shapes that are drawn. No failure schedules. */
export function flightContact(
	scene: FlightScene,
	flyer: Flyer,
	atTime = scene.time,
): FlightContact | null {
	const x = atTime * flightSpeed + scene.width * flyer.position;
	const polygons = aircraftPolygons(scene, flyer, atTime);
	const points = polygons.flat();
	const minX = Math.min(...points.map((p) => p.x));
	const maxX = Math.max(...points.map((p) => p.x));
	const minY = Math.min(...points.map((p) => p.y));
	const maxY = Math.max(...points.map((p) => p.y));
	const contact = (kind: FlightContact["kind"], key: string): FlightContact => ({
		kind,
		key,
		x,
		y: flyer.y,
		time: atTime,
	});
	if (minY <= 0 || maxY >= scene.height - 45)
		return contact("boundary", minY <= 0 ? "ceiling" : "ground");
	const hits = (rect: FlightRect) =>
		maxX >= rect.x &&
		minX <= rect.x + rect.width &&
		maxY >= rect.y &&
		minY <= rect.y + rect.height &&
		polygons.some((p) => polygonRect(p, rect));
	for (
		let index = Math.floor((x - 220) / flightSpacing);
		index <= Math.ceil((x + 150) / flightSpacing);
		index++
	) {
		const blimp = getBlimp(scene, index, atTime);
		if (blimp && maxX >= blimp.x && minX <= blimp.x + blimp.width) {
			if (
				hits(blimp.gondola) ||
				blimp.engines.some(hits) ||
				blimp.fins.some((fin) => polygons.some((polygon) => polygonPolygon(polygon, fin))) ||
				(maxY >= blimp.y &&
					minY <= blimp.y + blimp.height &&
					polygons.some((p) => polygonEllipse(p, blimp)))
			) {
				return contact("blimp", blimp.key);
			}
		}
		for (const tower of towerGeometry(index, scene.width, scene.height, scene.seed)) {
			if (maxX < tower.x - 12 || minX > tower.x + tower.width + 12) continue;
			for (const piece of towerStructure(scene, tower, atTime)) {
				if (
					hits(piece) ||
					(piece.antenna &&
						(hits({ x: piece.x + piece.width / 2 - 1, y: piece.y - 26, width: 2, height: 26 }) ||
							hits({ x: piece.x + piece.width / 2 - 3, y: piece.y - 6, width: 6, height: 6 })))
				)
					return contact("tower", tower.key);
			}
		}
	}
	return null;
}

/** Conservative, time-indexed space below each curved hull and above the actual tower floors. */
export function flightCorridor(scene: FlightScene, flyer: Flyer, atTime: number): FlightCorridor {
	const size = planeScale(scene, flyer);
	const radiusX = 19 * size;
	const radiusY = 12 * size;
	const x = atTime * flightSpeed + scene.width * flyer.position;
	let minY = radiusY + 4;
	let maxY = scene.height - 49 - radiusY;
	const nearest = Math.round((x - (scene.width < 600 ? 38 : 55)) / flightSpacing);
	let targetY = courseGate(nearest, scene.width, scene.height, scene.seed).center;
	for (let index = nearest - 1; index <= nearest + 1; index++) {
		const blimp = getBlimp(scene, index, atTime);
		if (blimp && x + radiusX > blimp.x && x - radiusX < blimp.x + blimp.width) {
			const middle = blimp.x + blimp.width / 2;
			const closestX = clamp(middle, x - radiusX, x + radiusX);
			const fraction = (closestX - middle) / (blimp.width / 2);
			const bottom =
				blimp.y + (blimp.height / 2) * (1 + Math.sqrt(Math.max(0, 1 - fraction * fraction)));
			minY = Math.max(minY, bottom + radiusY + 2);
			if (x + radiusX > blimp.gondola.x && x - radiusX < blimp.gondola.x + blimp.gondola.width)
				minY = Math.max(minY, blimp.gondola.y + blimp.gondola.height + radiusY + 2);
			for (const fin of blimp.fins) {
				if (
					x + radiusX > Math.min(...fin.map((p) => p.x)) &&
					x - radiusX < Math.max(...fin.map((p) => p.x))
				)
					minY = Math.max(minY, Math.max(...fin.map((p) => p.y)) + radiusY + 2);
			}
			for (const engine of blimp.engines) {
				if (x + radiusX > engine.x && x - radiusX < engine.x + engine.width)
					minY = Math.max(minY, engine.y + engine.height + radiusY + 2);
			}
		}
		for (const tower of towerGeometry(index, scene.width, scene.height, scene.seed)) {
			if (x + radiusX < tower.x - 12 || x - radiusX > tower.x + tower.width + 12) continue;
			for (const piece of towerStructure(scene, tower, atTime)) {
				if (x + radiusX > piece.x && x - radiusX < piece.x + piece.width)
					maxY = Math.min(maxY, piece.y - radiusY - 2);
				if (
					piece.antenna &&
					x + radiusX > piece.x + piece.width / 2 - 1 &&
					x - radiusX < piece.x + piece.width / 2 + 1
				)
					maxY = Math.min(maxY, piece.y - 26 - radiusY - 2);
			}
		}
	}
	targetY = clamp(targetY, minY + 10, maxY - 10);
	return { minY, maxY, targetY };
}

/** A jump cannot be cancelled: reserve headroom through its entire upward arc. */
export function hasHopHeadroom(scene: FlightScene, flyer: Flyer) {
	let probe = { y: flyer.y, velocity: flyer.velocity, cooldown: flyer.cooldown };
	for (let sample = 1; sample <= 14; sample++) {
		probe = stepFlightKinematics(probe, 1 / 30, sample === 1);
		const corridor = flightCorridor(scene, flyer, scene.time + sample / 30);
		if (probe.y < corridor.minY + 4) return false;
	}
	return true;
}

function obstacleBehind(scene: FlightScene, flyer: Flyer) {
	const tail =
		scene.time * flightSpeed + scene.width * flyer.position - 19 * planeScale(scene, flyer);
	const index = Math.floor(tail / flightSpacing);
	const blimp = getBlimp(scene, index);
	const end = Math.max(
		index * flightSpacing + (scene.width < 600 ? 76 : 110),
		blimp ? blimp.x + blimp.width : 0,
	);
	return tail > end ? index : index - 1;
}

function spawnFlight(scene: FlightScene, flyer: Flyer) {
	let minY = 0;
	let maxY = scene.height;
	for (let step = 0; step <= 6; step++) {
		const corridor = flightCorridor(scene, flyer, scene.time + step * 0.1);
		minY = Math.max(minY, corridor.minY);
		maxY = Math.min(maxY, corridor.maxY - 2.4 * step * step);
	}
	if (maxY - minY < 18) return false;
	const corridor = flightCorridor(scene, flyer, scene.time);
	flyer.y = clamp(corridor.targetY, minY + 8, maxY - 8);
	flyer.velocity = 0;
	flyer.cooldown = 0;
	flyer.pitch = 0;
	if (flightContact(scene, flyer)) return false;
	flyer.status = "flying";
	flyer.passed = 0;
	flyer.lastObstacle = obstacleBehind(scene, flyer);
	flyer.enteredAt = scene.time;
	flyer.nextDecision = scene.time;
	flyer.trail = [];
	return true;
}

export function resizeFlightScene(scene: FlightScene, width: number, height: number) {
	if (
		!Number.isFinite(width) ||
		!Number.isFinite(height) ||
		width <= 0 ||
		height <= 0 ||
		(scene.width === width && scene.height === height)
	)
		return;
	scene.width = width;
	scene.height = height;
	for (const flyer of scene.flyers) {
		flyer.trail = [];
		if (flyer.status === "flying" || scene.time === 0) {
			flyer.status = "waiting";
			flyer.respawnAt = scene.time;
			spawnFlight(scene, flyer);
		}
	}
}

/** Contact removes the aircraft immediately; the building's original collapse timer is retained. */
export function crashFlight(scene: FlightScene, flyer: Flyer, contact: FlightContact) {
	if (flyer.status !== "flying") return;
	flyer.status = "waiting";
	flyer.velocity = 0;
	flyer.lastContact = contact;
	flyer.respawnAt = scene.time + 2.2 + flightNoise(flyer.id + flyer.attempt * 19) * 0.8;
	scene.stats.crashes++;
	if (contact.kind === "tower" && !scene.damage.has(contact.key)) {
		const [index, side] = contact.key.split(":").map(Number);
		const tower = towerGeometry(index, scene.width, scene.height, scene.seed)[side];
		const seed = index * 7 + side * 31;
		scene.damage.set(tower.key, {
			index,
			side,
			started: scene.time,
			delay: 1 + flightNoise(seed) * 2,
			hitRatio: clamp((flyer.y - tower.roof) / (scene.height - 45 - tower.roof), 0.02, 0.75),
			seed,
		});
	} else if (contact.kind === "blimp") {
		const index = Number(contact.key.split(":")[1]);
		if (!scene.blimpDamage.has(index)) scene.blimpDamage.set(index, scene.time);
	}
}

function tickFlightScene(scene: FlightScene) {
	for (const flyer of scene.flyers) {
		flyer.trail = flyer.trail.filter((point) => scene.time - point.time < 1.2);
		if (flyer.status === "waiting") {
			if (scene.time >= flyer.respawnAt && spawnFlight(scene, flyer)) flyer.attempt++;
			continue;
		}
		let flap = false;
		if (scene.time + 1e-8 >= flyer.nextDecision) {
			const corridors = Array.from({ length: 30 }, (_, i) =>
				flightCorridor(scene, flyer, scene.time + (i + 1) * 0.1),
			);
			flap = planFlight(flyer, corridors).flap && hasHopHeadroom(scene, flyer);
			flyer.nextDecision += 0.1;
		}
		if (flap && flyer.cooldown <= 1e-8) scene.stats.hops++;
		Object.assign(flyer, stepFlightKinematics(flyer, physicsStep, flap));
		flyer.pitch = clamp(flyer.velocity / 480, -0.3, 0.45);
		const contact = flightContact(scene, flyer, scene.time + physicsStep);
		if (contact) {
			crashFlight(scene, flyer, contact);
			continue;
		}
		const behind = obstacleBehind(scene, flyer);
		if (flyer.lastObstacle !== null && behind > flyer.lastObstacle) {
			flyer.passed++;
			scene.stats.passes++;
			scene.stats.bestStreak = Math.max(scene.stats.bestStreak, flyer.passed);
		}
		flyer.lastObstacle = behind;
		const corridor = flightCorridor(scene, flyer, scene.time);
		if (Math.min(flyer.y - corridor.minY, corridor.maxY - flyer.y) < 8) scene.stats.nearMisses++;
		const lastPoint = flyer.trail.at(-1);
		if (!lastPoint || scene.time - lastPoint.time >= 0.06)
			flyer.trail.push({
				x: scene.time * flightSpeed + scene.width * flyer.position - 18 * planeScale(scene, flyer),
				y: flyer.y,
				time: scene.time,
			});
	}
	scene.ticks++;
	scene.time = scene.ticks * physicsStep;
	const behind = scene.time * flightSpeed - 400;
	for (const [key, damage] of scene.damage)
		if (damage.index * flightSpacing + 120 < behind) scene.damage.delete(key);
	for (const index of scene.blimpDamage.keys())
		if (index * flightSpacing + 180 < behind) scene.blimpDamage.delete(index);
}

/** Fixed 120 Hz simulation; a suspended tab never triggers an unbounded catch-up loop. */
export function advanceFlightScene(scene: FlightScene, delta: number) {
	if (!scene.width || !scene.height || !Number.isFinite(delta) || delta <= 0) return;
	scene.accumulator += Math.min(delta, 0.25);
	while (scene.accumulator + 1e-9 >= physicsStep) {
		tickFlightScene(scene);
		scene.accumulator = Math.max(0, scene.accumulator - physicsStep);
	}
}
