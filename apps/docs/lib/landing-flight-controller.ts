export const flightGravity = 480;
export const flightImpulse = -185;
export const flightHopCooldown = 0.2;
export const physicsStep = 1 / 120;

export type FlightKinematics = {
	y: number;
	velocity: number;
	cooldown: number;
};

export type FlightCorridor = {
	minY: number;
	maxY: number;
	targetY: number;
};

export function stepFlightKinematics(
	state: FlightKinematics,
	delta: number,
	flap: boolean,
): FlightKinematics {
	const jumped = flap && state.cooldown <= 0.000001;
	const velocity = jumped ? flightImpulse : state.velocity;
	return {
		y: state.y + velocity * delta + (flightGravity * delta * delta) / 2,
		velocity: velocity + flightGravity * delta,
		cooldown: Math.max(0, (jumped ? flightHopCooldown : state.cooldown) - delta),
	};
}

type SearchNode = FlightKinematics & {
	firstFlap: boolean;
	cost: number;
	rank: number;
};

const beamWidth = 20;
const maximumSamples = 40;

function routeCost(state: FlightKinematics, corridor: FlightCorridor): number {
	const target = Math.max(corridor.minY, Math.min(corridor.maxY, corridor.targetY));
	const halfGap = Math.max(24, (corridor.maxY - corridor.minY) / 2);
	const offset = (state.y - target) / halfGap;
	const clearance = Math.min(state.y - corridor.minY, corridor.maxY - state.y);
	const edgeRisk = Math.max(0, 14 - clearance) / 14;
	return offset * offset + edgeRisk * edgeRisk * 0.35;
}

function terminalRisk(state: FlightKinematics, corridor: FlightCorridor): number {
	// A jump cannot be cancelled. Penalize arriving at the end of the visible
	// route with enough upward momentum to hit its ceiling after the horizon.
	const remainingRise =
		state.velocity < 0 ? (state.velocity * state.velocity) / (2 * flightGravity) : 0;
	const overshoot = Math.max(0, corridor.minY + 4 - (state.y - remainingRise));
	const fallingNearFloor =
		Math.max(0, state.y + Math.max(0, state.velocity) * 0.1 - corridor.maxY + 4) / 24;
	return (overshoot / 24) ** 2 + fallingNearFloor * fallingNearFloor * 0.25;
}

/**
 * Search literal flap/no-flap inputs, never a smoothed target trajectory.
 * Each corridor describes legal aircraft-center positions at the next sample;
 * the caller supplies collision margins and any swept obstacle constraints.
 */
export function planFlight(
	state: FlightKinematics,
	corridors: readonly FlightCorridor[],
	sampleStep = 0.1,
): { flap: boolean; safeFor: number } {
	if (corridors.length === 0 || sampleStep <= 0) return { flap: false, safeFor: 0 };

	let beam: SearchNode[] = [{ ...state, firstFlap: false, cost: 0, rank: 0 }];
	let best = beam[0];
	let safeFor = 0;
	const sampleCount = Math.min(maximumSamples, corridors.length);

	for (let sample = 0; sample < sampleCount; sample++) {
		const corridor = corridors[sample];
		const candidates: SearchNode[] = [];
		let leastUnsafe: SearchNode | undefined;
		let smallestViolation = Number.POSITIVE_INFINITY;

		for (const node of beam) {
			const choices = node.cooldown <= 0.000001 ? 2 : 1;
			for (let action = 0; action < choices; action++) {
				const flap = action === 1;
				const next = stepFlightKinematics(node, sampleStep, flap);
				const firstFlap = sample === 0 ? flap : node.firstFlap;
				const cost = node.cost + routeCost(next, corridor) + (flap ? 0.012 : 0);
				const candidate: SearchNode = {
					...next,
					firstFlap,
					cost,
					rank: cost + terminalRisk(next, corridor) * 0.15,
				};
				const violation = Math.max(corridor.minY - next.y, next.y - corridor.maxY, 0);
				if (violation > 0 || corridor.minY > corridor.maxY) {
					if (violation < smallestViolation) {
						smallestViolation = violation;
						leastUnsafe = candidate;
					}
					continue;
				}
				candidates.push(candidate);
			}
		}

		if (candidates.length === 0) {
			// When the first sample is already unavoidable, still choose the input
			// with the smallest penetration. Otherwise preserve the longest safe
			// route found so far and let the real collision engine decide its fate.
			if (sample === 0 && leastUnsafe) best = leastUnsafe;
			break;
		}

		candidates.sort((a, b) => a.rank - b.rank);
		const occupied = new Set<string>();
		beam = [];
		for (const candidate of candidates) {
			// Retain distinct altitude/momentum combinations so a slightly more
			// expensive early dive or climb survives long enough to pay off.
			const bucket = `${Math.floor(candidate.y / 5)}:${Math.round(candidate.velocity / 24)}:${Math.ceil(candidate.cooldown / sampleStep)}`;
			if (occupied.has(bucket)) continue;
			occupied.add(bucket);
			beam.push(candidate);
			if (beam.length === beamWidth) break;
		}
		best = beam[0];
		safeFor = (sample + 1) * sampleStep;
	}

	return { flap: best.firstFlap, safeFor };
}
