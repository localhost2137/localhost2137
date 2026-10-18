import { describe, expect, it } from "vitest";
import {
	advanceFlightScene,
	campaignCandidates,
	clamp,
	collapseDuration,
	createFlightScene,
	type FlightScene,
	type Flyer,
	flightContact,
	flightSpeed,
	getBlimp,
	hasHopHeadroom,
	resizeFlightScene,
	towerGeometry,
	towerStructure,
} from "../apps/docs/lib/landing-flight";
import {
	flightGravity,
	flightHopCooldown,
	flightImpulse,
	physicsStep,
	planFlight,
	stepFlightKinematics,
} from "../apps/docs/lib/landing-flight-controller";

function sceneAt(width = 1440, height = 693, seed = 2137) {
	const scene = createFlightScene(seed);
	resizeFlightScene(scene, width, height);
	return scene;
}

function advanceFor(scene: FlightScene, seconds: number, pattern: number[]) {
	let elapsed = 0;
	let frame = 0;
	while (elapsed < seconds - 1e-10) {
		const delta = Math.min(pattern[frame++ % pattern.length], seconds - elapsed);
		advanceFlightScene(scene, delta);
		elapsed += delta;
	}
}

function placeFlyer(scene: FlightScene, flyer: Flyer, x: number, y: number, time = scene.time) {
	flyer.position = (x - time * flightSpeed) / scene.width;
	flyer.y = y;
	flyer.velocity = 0;
	flyer.pitch = 0;
	flyer.cooldown = 0;
	flyer.status = "flying";
	flyer.nextDecision = Number.POSITIVE_INFINITY;
}

describe("landing flight physics and controller", () => {
	it("integrates the same jump at render and physics rates without mutating its input", () => {
		const initial = { y: 200, velocity: 60, cooldown: 0 };
		const frame = stepFlightKinematics(initial, 0.1, true);
		let ticks = initial;
		for (let tick = 0; tick < 12; tick++)
			ticks = stepFlightKinematics(ticks, physicsStep, tick === 0);

		expect(initial).toEqual({ y: 200, velocity: 60, cooldown: 0 });
		expect(frame.y).toBeCloseTo(200 + flightImpulse * 0.1 + (flightGravity * 0.1 ** 2) / 2, 12);
		expect(frame.velocity).toBe(flightImpulse + flightGravity * 0.1);
		expect(ticks.y).toBeCloseTo(frame.y, 10);
		expect(ticks.velocity).toBeCloseTo(frame.velocity, 10);
		expect(ticks.cooldown).toBeCloseTo(frame.cooldown, 10);

		const earlyJump = stepFlightKinematics(frame, 0.1, true);
		expect(earlyJump.velocity).toBeCloseTo(frame.velocity + flightGravity * 0.1, 10);
		const availableJump = stepFlightKinematics(earlyJump, physicsStep, true);
		expect(availableJump.velocity).toBe(flightImpulse + flightGravity * physicsStep);
		expect(availableJump.cooldown).toBeCloseTo(flightHopCooldown - physicsStep, 10);
	});

	it("plans literal jumps through a moving narrow corridor and repeats deterministically", () => {
		const corridorAt = (time: number) => {
			const targetY = 200 + Math.sin(time * 0.55) * 65;
			return { minY: targetY - 36, maxY: targetY + 36, targetY };
		};
		let state = { y: 200, velocity: 0, cooldown: 0 };
		let jumps = 0;
		for (let tick = 0; tick < 300; tick++) {
			const time = tick * 0.1;
			const corridors = Array.from({ length: 32 }, (_, i) => corridorAt(time + (i + 1) * 0.1));
			const plan = planFlight(state, corridors);
			expect(planFlight(state, corridors)).toEqual(plan);
			state = stepFlightKinematics(state, 0.1, plan.flap);
			if (plan.flap) jumps++;
			const corridor = corridorAt(time + 0.1);
			expect(state.y).toBeGreaterThanOrEqual(corridor.minY);
			expect(state.y).toBeLessThanOrEqual(corridor.maxY);
		}
		expect(jumps).toBeGreaterThan(20);
	});

	it("rejects an uncancellable jump that reaches a blimp after the next decision, but permits a clear arc", () => {
		const scene = sceneAt();
		const flyer = scene.flyers[0];
		const blimp = getBlimp(scene, 1);
		if (!blimp) throw new Error("Expected an undamaged blimp");
		// Already collapsed towers isolate the ceiling hazard from the lower course.
		for (const tower of towerGeometry(1, scene.width, scene.height, scene.seed))
			scene.damage.set(tower.key, {
				index: tower.index,
				side: tower.side,
				started: -10,
				delay: 1,
				hitRatio: 0.2,
				seed: 7,
			});
		const probeJump = (clearance: number) => {
			placeFlyer(
				scene,
				flyer,
				blimp.x + blimp.width * 0.35,
				blimp.gondola.y + blimp.gondola.height + clearance,
			);
			expect(flightContact(scene, flyer)).toBeNull();
			const allowed = hasHopHeadroom(scene, flyer);
			const probe = { ...flyer };
			// Trace a full ballistic rise at the real collision timestep, rather
			// than repeating the guard's conservative corridor samples.
			for (let tick = 1; tick <= 60; tick++) {
				Object.assign(probe, stepFlightKinematics(probe, physicsStep, tick === 1));
				probe.pitch = clamp(probe.velocity / 480, -0.3, 0.45);
				const contact = flightContact(scene, probe, tick * physicsStep);
				if (contact) return { allowed, contact };
			}
			return { allowed, contact: null };
		};
		const unsafe = probeJump(45);
		expect(unsafe.allowed).toBe(false);
		expect(unsafe.contact).toMatchObject({ kind: "blimp", key: blimp.key });
		expect(unsafe.contact?.time).toBeGreaterThan(0.1);
		expect(probeJump(80)).toEqual({ allowed: true, contact: null });
	});

	it("produces exactly the same world at 30, 60, 144 Hz and with frame jitter", () => {
		const patterns = [[1 / 30], [1 / 60], [1 / 144], [0.004, 0.037, 0.011, 0.08, 0.016]];
		const scenes = patterns.map((pattern) => {
			const scene = sceneAt();
			advanceFor(scene, 18, pattern);
			expect(scene.ticks).toBe(18 * 120);
			expect(scene.time).toBe(18);
			// The fractional remainder belongs to rendering, not the simulated world.
			return { ...scene, accumulator: 0 };
		});
		for (const scene of scenes.slice(1)) expect(scene).toEqual(scenes[0]);
	}, 20_000);

	it("ignores invalid deltas and bounds catch-up after a suspended frame", () => {
		const scene = sceneAt();
		const before = structuredClone(scene);
		for (const delta of [0, -1, Number.NaN, Number.POSITIVE_INFINITY])
			advanceFlightScene(scene, delta);
		expect(scene).toEqual(before);
		advanceFlightScene(scene, 3_600);
		expect(scene.time).toBe(0.25);
		expect(scene.ticks).toBe(30);
		expect(scene.accumulator).toBeLessThan(physicsStep);
	});
});

describe("contacts match visible obstacles", () => {
	it("hits tower walls and antennas, while clearing nearby empty air", () => {
		const scene = sceneAt();
		const flyer = scene.flyers[0];
		const tower = towerGeometry(1, scene.width, scene.height, scene.seed)[0];
		placeFlyer(scene, flyer, tower.x + tower.width / 2, tower.roof + 40);
		expect(flightContact(scene, flyer)).toMatchObject({ kind: "tower", key: tower.key });

		placeFlyer(scene, flyer, tower.x + tower.width / 2, tower.roof - 19);
		expect(flightContact(scene, flyer)).toMatchObject({ kind: "tower", key: tower.key });
		placeFlyer(scene, flyer, tower.x + tower.width / 2 - 45, tower.roof - 19);
		expect(flightContact(scene, flyer)).toBeNull();
	});

	it("uses the curved blimp hull and includes its separate gondola", () => {
		const scene = sceneAt();
		const flyer = scene.flyers[0];
		const blimp = getBlimp(scene, 1);
		expect(blimp).not.toBeNull();
		if (!blimp) throw new Error("Expected an undamaged blimp");
		placeFlyer(scene, flyer, blimp.x + blimp.width / 2, blimp.y + blimp.height / 2);
		expect(flightContact(scene, flyer)).toMatchObject({ kind: "blimp", key: blimp.key });
		// A small sprite can touch the gondola without also reaching the hull.
		flyer.size = 0.2;
		placeFlyer(
			scene,
			flyer,
			blimp.gondola.x + blimp.gondola.width / 2,
			blimp.gondola.y + blimp.gondola.height / 2,
		);
		expect(flightContact(scene, flyer)).toMatchObject({ kind: "blimp", key: blimp.key });

		// A small aircraft in the bounding box's corner is outside the ellipse.
		placeFlyer(scene, flyer, blimp.x + 3, blimp.y + 3);
		expect(flightContact(scene, flyer)).toBeNull();
	});

	it("hits exposed tail fins and engine pods outside the hull, but not adjacent empty air", () => {
		const scene = sceneAt();
		const flyer = scene.flyers[0];
		const blimp = getBlimp(scene, 1);
		if (!blimp) throw new Error("Expected an undamaged blimp");
		flyer.size = 0.12;
		for (const [fin, direction] of [
			[blimp.fins[0], -1],
			[blimp.fins[1], 1],
		] as const) {
			const outerY =
				direction < 0 ? Math.min(...fin.map((p) => p.y)) : Math.max(...fin.map((p) => p.y));
			const edge = fin.filter((point) => point.y === outerY);
			const x = edge.reduce((sum, point) => sum + point.x, 0) / edge.length;
			placeFlyer(scene, flyer, x, outerY - direction * 2);
			expect(flightContact(scene, flyer)).toMatchObject({ kind: "blimp", key: blimp.key });
			placeFlyer(scene, flyer, x, outerY + direction * 5);
			expect(flightContact(scene, flyer)).toBeNull();
		}
		flyer.size = 0.05;
		for (const engine of blimp.engines) {
			const y = engine.y + engine.height - 0.25;
			expect(y - flyer.size * 8).toBeGreaterThan(blimp.y + blimp.height);
			placeFlyer(scene, flyer, engine.x + engine.width / 2, y);
			expect(flightContact(scene, flyer)).toMatchObject({ kind: "blimp", key: blimp.key });
		}
	});

	it("ends flight on contact and retains the original tower collapse timer on a second hit", () => {
		const scene = sceneAt();
		const [first, second] = scene.flyers;
		second.status = "waiting";
		second.respawnAt = Number.POSITIVE_INFINITY;
		const tower = towerGeometry(1, scene.width, scene.height, scene.seed)[0];
		placeFlyer(scene, first, tower.x + tower.width / 2, tower.roof + 15);
		advanceFlightScene(scene, physicsStep);
		expect(first.status).toBe("waiting");
		expect(first.velocity).toBe(0);
		expect(first.lastContact).toMatchObject({ kind: "tower", key: tower.key });
		const stoppedY = first.y;
		const damage = scene.damage.get(tower.key);
		expect(damage).toBeDefined();
		expect(damage?.delay).toBeGreaterThanOrEqual(1);
		expect(damage?.delay).toBeLessThanOrEqual(3);

		advanceFor(scene, 0.5, [1 / 60]);
		expect(first.y).toBe(stoppedY);
		placeFlyer(scene, second, tower.x + tower.width / 2, tower.roof + 15);
		advanceFlightScene(scene, physicsStep);
		expect(second.status).toBe("waiting");
		expect(scene.damage.get(tower.key)).toBe(damage);
		expect(scene.stats.crashes).toBe(2);
	});

	it("collides with the shared falling floor geometry until the tower finishes collapsing", () => {
		const scene = sceneAt();
		const flyer = scene.flyers[0];
		flyer.size = 0.2;
		const tower = towerGeometry(1, scene.width, scene.height, scene.seed)[0];
		const delay = 1.5;
		scene.damage.set(tower.key, { index: 1, side: 0, started: 0, delay, hitRatio: 0.2, seed: 7 });
		expect(towerStructure(scene, tower, delay - 0.01)).toHaveLength(1);
		const fallingTime = delay + collapseDuration * 0.4;
		const pieces = towerStructure(scene, tower, fallingTime);
		expect(pieces.length).toBeGreaterThan(1);
		const top = pieces.reduce((highest, piece) => (piece.y < highest.y ? piece : highest));
		expect(top.y).toBeGreaterThan(tower.roof);
		placeFlyer(scene, flyer, top.x + top.width / 2, top.y + top.height / 2, fallingTime);
		expect(flightContact(scene, flyer, fallingTime)).toMatchObject({
			kind: "tower",
			key: tower.key,
		});

		const finishedTime = delay + collapseDuration + 0.01;
		expect(towerStructure(scene, tower, finishedTime)).toEqual([]);
		placeFlyer(scene, flyer, tower.x + tower.width / 2, tower.roof + 20, finishedTime);
		expect(flightContact(scene, flyer, finishedTime)).toBeNull();
	});
});

describe("procedural courses", () => {
	it.each([
		[390, 680],
		[1440, 693],
	])(
		"keeps two participants, bounded state and frequent tower collisions over two minutes at %i × %i",
		(width, height) => {
			const scene = sceneAt(width, height);
			const lastContactTimes = new Map<number, number>();
			const contacts = { tower: 0, blimp: 0, boundary: 0 };
			for (let frame = 0; frame < 480; frame++) {
				advanceFlightScene(scene, 0.25);
				expect(scene.flyers).toHaveLength(2);
				expect(scene.damage.size).toBeLessThan(12);
				expect(scene.blimpDamage.size).toBeLessThan(8);
				for (const flyer of scene.flyers) {
					const contact = flyer.lastContact;
					if (contact && lastContactTimes.get(flyer.id) !== contact.time) {
						lastContactTimes.set(flyer.id, contact.time);
						contacts[contact.kind]++;
					}
					expect(
						[flyer.y, flyer.velocity, flyer.pitch, flyer.cooldown].every(Number.isFinite),
					).toBe(true);
					expect(flyer.cooldown).toBeGreaterThanOrEqual(0);
					expect(flyer.cooldown).toBeLessThanOrEqual(flightHopCooldown);
					expect(flyer.trail.length).toBeLessThanOrEqual(24);
					for (const point of flyer.trail) expect(scene.time - point.time).toBeLessThan(1.22);
				}
			}
			expect(scene.time).toBe(120);
			expect(scene.stats.passes).toBeGreaterThan(2);
			expect(scene.stats.hops).toBeGreaterThan(scene.stats.passes);
			const crashes = contacts.tower + contacts.blimp + contacts.boundary;
			expect(crashes).toBe(scene.stats.crashes);
			expect(crashes).toBeGreaterThanOrEqual(14);
			expect(contacts.tower / crashes).toBeGreaterThanOrEqual(0.9);
			expect(contacts.boundary).toBe(0);
		},
		30_000,
	);

	it("gives every campaign equal frequency and identical hull, gondola and engine dimensions", () => {
		for (const seed of [1, 19, 2137, 9999]) {
			const scene = sceneAt(1440, 693, seed);
			const shapes: unknown[] = [];
			for (let bag = -3; bag < 6; bag++) {
				const candidates = new Set<string>();
				for (let slot = 0; slot < campaignCandidates.length; slot++) {
					const blimp = getBlimp(scene, bag * campaignCandidates.length + slot);
					if (!blimp) throw new Error("Expected an undamaged blimp");
					candidates.add(blimp.candidate);
					shapes.push({
						width: blimp.width,
						height: blimp.height,
						gondolaWidth: blimp.gondola.width,
						gondolaHeight: blimp.gondola.height,
						engines: blimp.engines.map(({ width, height }) => ({ width, height })),
					});
				}
				expect(candidates).toEqual(new Set(campaignCandidates));
			}
			for (const shape of shapes) expect(shape).toEqual(shapes[0]);
		}
	});
});
