import {
	type CampaignBlimp,
	clamp,
	collapseDuration,
	collapseProgress,
	type FlightScene,
	type Flyer,
	flightNoise,
	flightSpacing,
	flightSpeed,
	getBlimp,
	type Tower,
	type TowerDamage,
	towerGeometry,
	towerStructure,
} from "./landing-flight";

export type FlightPalette = {
	tower: string;
	line: string;
	cloud: string;
	plane: string;
	outline: string;
	wing: string;
	smoke: string;
	dust: string;
	scorch: string;
};

const campaignGlyphs: Record<string, string> = {
	A: "010101111101101",
	B: "110101110101110",
	C: "011100100100011",
	D: "110101101101110",
	E: "111100110100111",
	G: "011100101101011",
	H: "101101111101101",
	I: "111010010010111",
	K: "101101110101101",
	M: "101111111101101",
	N: "101111111111101",
	O: "010101101101010",
	P: "110101110100100",
	R: "110101110101101",
	S: "011100010001110",
	T: "111010010010010",
	U: "101101101101111",
	Y: "101101010010010",
};

function pixelLabel(
	context: CanvasRenderingContext2D,
	label: string,
	x: number,
	y: number,
	scale: number,
) {
	for (let letter = 0; letter < label.length; letter++) {
		const glyph = campaignGlyphs[label[letter]];
		if (!glyph) continue;
		for (let pixel = 0; pixel < glyph.length; pixel++) {
			if (glyph[pixel] === "1") {
				context.fillRect(
					x + (letter * 4 + (pixel % 3)) * scale,
					y + Math.floor(pixel / 3) * scale,
					scale,
					scale,
				);
			}
		}
	}
}

/** The stepped hull stays inside the engine's ellipse. Fins use separate collision polygons. */
function envelope(
	context: CanvasRenderingContext2D,
	x: number,
	y: number,
	width: number,
	height: number,
) {
	for (let row = 0; row < height; row += 2) {
		const rowHeight = Math.min(2, height - row);
		const edge = Math.max(
			Math.abs((row / height) * 2 - 1),
			Math.abs(((row + rowHeight) / height) * 2 - 1),
		);
		const inset = Math.ceil((width / 2 - (width / 2) * Math.sqrt(1 - edge * edge)) / 2) * 2;
		context.fillRect(x + inset, y + row, Math.max(0, width - inset * 2), rowHeight);
	}
}

function campaignPortrait(
	context: CanvasRenderingContext2D,
	candidate: CampaignBlimp["candidate"],
	x: number,
	y: number,
	scale: number,
	colors: FlightPalette,
) {
	context.save();
	context.translate(x, y);
	context.scale(scale, scale);
	context.fillStyle = colors.wing;
	context.fillRect(1, 16, 20, 8);
	context.fillRect(4, 14, 14, 3);
	context.fillStyle = candidate === "obama" ? "#ad8568" : "#dfccae";
	context.fillRect(8, 11, 7, 6);
	context.fillRect(5, 4, 12, 9);
	context.fillRect(6, 12, 10, 2);
	context.fillRect(4, 7, 1, 3);
	context.fillRect(17, 7, 1, 3);
	context.fillStyle = candidate === "obama" ? "#856752" : "#b59d82";
	context.fillRect(10, 8, 2, 3);
	context.fillRect(8, 12, 6, 1);
	context.fillStyle = colors.outline;
	context.fillRect(7, 7, 2, 1);
	context.fillRect(14, 7, 2, 1);
	if (candidate === "trump") {
		context.fillStyle = "#cbb77b";
		context.fillRect(4, 2, 14, 3);
		context.fillRect(6, 0, 10, 3);
		context.fillRect(2, 3, 6, 2);
		context.fillRect(15, 4, 3, 2);
		context.fillStyle = "#e3d29a";
		context.fillRect(5, 2, 10, 1);
	} else if (candidate === "biden") {
		context.fillStyle = "#e4e1d6";
		context.fillRect(6, 1, 10, 2);
		context.fillRect(4, 3, 4, 3);
		context.fillRect(15, 3, 3, 3);
		context.fillRect(4, 5, 2, 3);
		context.fillRect(16, 5, 2, 3);
	} else if (candidate === "kennedy") {
		context.fillStyle = "#76716b";
		context.fillRect(4, 2, 14, 3);
		context.fillRect(7, 0, 8, 3);
		context.fillRect(4, 4, 2, 3);
		context.fillRect(15, 4, 3, 3);
		context.fillStyle = "#afaba1";
		context.fillRect(5, 2, 3, 1);
		context.fillRect(15, 4, 2, 2);
	} else if (candidate === "obama") {
		context.fillStyle = "#555451";
		context.fillRect(6, 1, 10, 3);
		context.fillRect(5, 3, 2, 3);
		context.fillRect(15, 3, 2, 3);
		context.fillStyle = "#93918a";
		context.fillRect(5, 5, 1, 2);
		context.fillRect(16, 5, 1, 2);
	} else {
		context.fillStyle = "#8d8980";
		context.fillRect(5, 1, 12, 3);
		context.fillRect(4, 3, 3, 4);
		context.fillRect(15, 3, 3, 4);
		context.fillStyle = "#c5c0b4";
		context.fillRect(7, 1, 8, 1);
		context.fillRect(6, 2, 5, 1);
		context.fillRect(4, 5, 2, 2);
		context.fillRect(16, 5, 2, 2);
	}
	context.fillStyle = colors.plane;
	context.fillRect(7, 15, 4, 3);
	context.fillRect(12, 15, 4, 3);
	context.fillStyle = "#a98979";
	context.fillRect(11, 16, 2, 7);
	context.restore();
}

function campaignBlimp(
	context: CanvasRenderingContext2D,
	blimp: CampaignBlimp,
	scene: FlightScene,
	colors: FlightPalette,
) {
	const distance = scene.time * flightSpeed;
	const x = blimp.x - distance;
	const { y, width, height, gondola, damageAge } = blimp;
	if (x + width < -90 || x > scene.width + 90) return;
	const centerY = y + height / 2;
	const cabinX = gondola.x - distance;
	context.save();
	context.globalAlpha = blimp.opacity;
	context.strokeStyle = colors.line;
	context.lineWidth = 1;
	// Rigid tail surfaces are separate authoritative collision polygons, behind the hull.
	for (const fin of blimp.fins) {
		context.beginPath();
		for (let point = 0; point < fin.length; point++) {
			const position = fin[point];
			if (point === 0) context.moveTo(position.x - distance, position.y);
			else context.lineTo(position.x - distance, position.y);
		}
		context.closePath();
		context.fillStyle = colors.tower;
		context.fill();
		context.stroke();
		context.save();
		context.clip();
		context.globalAlpha *= 0.45;
		context.fillStyle = colors.line;
		context.fillRect(x + width * 0.93, y - height * 0.45, 2, height * 1.9);
		context.globalAlpha *= 0.45;
		context.fillRect(x + width * 0.72, centerY, width * 0.28, height);
		context.restore();
	}
	// A close-coupled cabin and engine pods give the airship a coherent lower silhouette.
	context.fillStyle = colors.line;
	context.fillRect(cabinX, gondola.y, gondola.width, gondola.height);
	context.fillStyle = colors.tower;
	context.fillRect(cabinX + 1, gondola.y + 1, gondola.width - 2, gondola.height - 2);
	context.fillStyle = colors.wing;
	const windowHeight = Math.max(1, Math.min(4, gondola.height - 4));
	for (let window = 4; window < gondola.width - 3; window += 6) {
		context.fillRect(cabinX + window, gondola.y + 2, 3, windowHeight);
	}
	context.fillStyle = colors.line;
	context.fillRect(cabinX + 2, gondola.y + gondola.height - 3, gondola.width - 4, 1);
	for (let index = 0; index < blimp.engines.length; index++) {
		const engine = blimp.engines[index];
		const engineX = engine.x - distance;
		context.fillStyle = colors.line;
		context.fillRect(engineX, engine.y, engine.width, engine.height);
		context.fillStyle = colors.tower;
		context.fillRect(engineX + 2, engine.y + 1, engine.width - 3, engine.height - 2);
		context.fillStyle = colors.wing;
		context.fillRect(engineX + 5, engine.y + engine.height / 2, engine.width - 7, 2);
		const propeller = damageAge === null ? Math.sin(scene.time * 42 + index * 2) : 0.3;
		const bladeHeight = 2 + Math.abs(propeller) * Math.max(0, engine.height - 2);
		context.fillStyle = colors.outline;
		context.fillRect(engineX + 2, engine.y + (engine.height - bladeHeight) / 2, 1, bladeHeight);
		context.fillRect(engineX + 1, engine.y + engine.height / 2 - 1, 4, 2);
	}
	context.fillStyle = colors.line;
	envelope(context, x, y, width, height);
	context.fillStyle = colors.tower;
	envelope(context, x + 1, y + 1, width - 2, height - 2);
	// Soft silver panels follow the long cigar shape. The narrow stepped edge stays crisp.
	context.save();
	context.beginPath();
	context.ellipse(x + width / 2, centerY, width / 2 - 2, height / 2 - 2, 0, 0, Math.PI * 2);
	context.clip();
	context.globalAlpha *= 0.22;
	context.fillStyle = "#aeb8b8";
	context.fillRect(x, y + 1, width, height * 0.52);
	context.globalAlpha = blimp.opacity * 0.28;
	context.fillStyle = "#f0f1eb";
	context.beginPath();
	context.moveTo(x + 3, centerY);
	context.quadraticCurveTo(x + width * 0.46, y - height * 0.13, x + width - 3, centerY);
	context.quadraticCurveTo(x + width * 0.48, y + height * 0.17, x + 3, centerY);
	context.fill();
	context.globalAlpha = blimp.opacity * 0.15;
	context.fillStyle = "#65716f";
	context.beginPath();
	context.moveTo(x, centerY);
	context.quadraticCurveTo(x + width / 2, y + height * 1.05, x + width, centerY);
	context.lineTo(x + width, y + height);
	context.lineTo(x, y + height);
	context.closePath();
	context.fill();
	context.globalAlpha = blimp.opacity * 0.3;
	context.strokeStyle = colors.line;
	context.lineWidth = 0.7;
	// Circumferential ribs reveal the rigid framework beneath the envelope fabric.
	for (let rib = 1; rib < 11; rib++) {
		const fraction = rib / 11;
		const radiusY = (height / 2) * Math.sqrt(1 - (fraction * 2 - 1) ** 2);
		context.beginPath();
		context.ellipse(x + width * fraction, centerY, width * 0.015, radiusY, 0, 0, Math.PI * 2);
		context.stroke();
	}
	for (const panel of [-0.52, 0.38]) {
		context.beginPath();
		context.moveTo(x + 3, centerY);
		context.quadraticCurveTo(x + width / 2, centerY + height * panel, x + width - 3, centerY);
		context.stroke();
	}
	context.globalAlpha = blimp.opacity * 0.4;
	context.fillStyle = colors.line;
	context.fillRect(x + width * 0.24, centerY - 1, width * 0.04, 2);
	context.fillRect(x + width * 0.26 - 1, centerY - 4, 2, 8);
	context.restore();
	const portraitScale = Math.min(1.3, height / 29, width / 150);
	campaignPortrait(
		context,
		blimp.candidate,
		x + width * 0.34,
		centerY - 12 * portraitScale,
		portraitScale,
		colors,
	);
	const labelX = x + width * 0.5;
	const labelScale = Math.min(1.6, width / 126, height / 28);
	context.fillStyle = colors.line;
	pixelLabel(context, "CAMPAIGN", labelX, centerY - 11 * labelScale, labelScale * 0.6);
	context.fillStyle = colors.outline;
	pixelLabel(context, blimp.candidate.toUpperCase(), labelX, centerY - 2 * labelScale, labelScale);
	if (damageAge !== null) {
		const tearX = x + width * 0.73;
		const tearY = centerY + height * 0.16;
		context.fillStyle = colors.scorch;
		context.fillRect(tearX, tearY - 4, 4, 12);
		context.fillRect(tearX - 4, tearY, 12, 3);
		context.fillRect(tearX + 4, tearY + 5, 5, 3);
		fragments(context, tearX, tearY, scene.height - 45, damageAge, blimp.index * 53, colors, false);
		// A soft leak dissipates while the engine lowers and deflates the actual hull.
		for (let puff = 0; puff < 5; puff++) {
			const age = damageAge - puff * 0.16;
			if (age < 0 || age > 2.3) continue;
			context.globalAlpha = blimp.opacity * Math.sin((age / 2.3) * Math.PI) * 0.22;
			context.fillStyle = colors.smoke;
			cloud(context, tearX - age * 14 + puff * 3, tearY - age * 19, 8 + age * 11);
		}
	}
	context.restore();
}

function cloud(context: CanvasRenderingContext2D, x: number, y: number, size: number) {
	context.fillRect(x - size * 0.5, y - size * 0.2, size, size * 0.55);
	context.fillRect(x - size * 0.35, y - size * 0.4, size * 0.65, size * 0.3);
	context.fillRect(x - size * 0.25, y + size * 0.3, size * 0.65, size * 0.2);
}

function facade(
	context: CanvasRenderingContext2D,
	x: number,
	y: number,
	width: number,
	height: number,
	colors: FlightPalette,
	alpha = 1,
) {
	if (height <= 0) return;
	context.save();
	context.globalAlpha = alpha;
	context.fillStyle = colors.tower;
	context.fillRect(x, y, width, height);
	context.strokeStyle = colors.line;
	context.lineWidth = 1;
	context.strokeRect(x + 0.5, y + 0.5, width - 1, height);
	context.fillStyle = colors.cloud;
	context.fillRect(x + width - 7, y + 1, 6, Math.max(0, height - 1));
	context.fillStyle = colors.line;
	context.globalAlpha = alpha * 0.55;
	for (let column = 5; column < width - 4; column += 5) {
		context.fillRect(x + column, y + 1, 1, Math.max(0, height - 2));
	}
	context.globalAlpha = alpha * 0.24;
	for (let row = 11; row < height; row += 11) context.fillRect(x + 3, y + row, width - 6, 1);
	context.restore();
}

function antenna(context: CanvasRenderingContext2D, x: number, roof: number, width: number) {
	context.fillRect(x + width / 2 - 1, roof - 26, 2, 26);
	context.fillRect(x + width / 2 - 3, roof - 6, 6, 6);
}

function rubble(
	context: CanvasRenderingContext2D,
	x: number,
	floor: number,
	tower: Tower,
	colors: FlightPalette,
	progress: number,
) {
	context.save();
	context.globalAlpha = clamp(progress * 2);
	for (let piece = 0; piece < 15; piece++) {
		const seed = tower.index * 29 + tower.side * 17 + piece;
		const width = 4 + flightNoise(seed) * 10;
		const height = 3 + flightNoise(seed + 2) * 9;
		const position = x - 14 + flightNoise(seed + 6) * (tower.width + 28);
		context.fillStyle = piece % 3 === 0 ? colors.line : colors.tower;
		context.fillRect(position, floor - height, width, height);
	}
	context.restore();
}

function building(
	context: CanvasRenderingContext2D,
	tower: Tower,
	damage: TowerDamage | undefined,
	scene: FlightScene,
	colors: FlightPalette,
) {
	const floor = scene.height - 45;
	const x = tower.x - scene.time * flightSpeed;
	const height = floor - tower.roof;
	const progress = collapseProgress(damage, scene.time);
	const age = damage ? scene.time - damage.started : 0;
	const hitY = tower.roof + height * (damage?.hitRatio ?? 0.2);
	const pieces = towerStructure(scene, tower);
	for (const piece of pieces) {
		const pieceX = piece.x - scene.time * flightSpeed;
		facade(context, pieceX, piece.y, piece.width, piece.height, colors);
		if (piece.antenna) {
			context.fillStyle = colors.line;
			antenna(context, pieceX, piece.y, piece.width);
		}
	}
	if (progress === 0) {
		context.fillStyle = colors.line;
		const intact = pieces[0];
		if (intact) {
			context.fillRect(intact.x - scene.time * flightSpeed, intact.y + 5, intact.width, 2);
		}
		if (damage) {
			context.fillStyle = colors.scorch;
			context.fillRect(x + 3, hitY - 5, tower.width - 6, 10);
			context.fillRect(x + 8, hitY - 9, tower.width * 0.45, 18);
			// Small, uneven cracks spread from the damaged floors before they give way.
			context.strokeStyle = colors.scorch;
			context.beginPath();
			context.moveTo(x + 3, hitY + 2);
			context.lineTo(x + 14, hitY + 11);
			context.lineTo(x + 9, hitY + 16 + Math.min(age, 2) * 8);
			context.moveTo(x + tower.width - 4, hitY - 4);
			context.lineTo(x + tower.width - 12, hitY - 14);
			context.stroke();
		}
	}
	if (progress > 0) rubble(context, x, floor, tower, colors, progress);
}

function fragments(
	context: CanvasRenderingContext2D,
	originX: number,
	originY: number,
	floor: number,
	age: number,
	seed: number,
	colors: FlightPalette,
	collapsing: boolean,
) {
	const count = collapsing ? 26 : 17;
	for (let piece = 0; piece < count; piece++) {
		const start = collapsing ? (piece / count) * 1.1 : 0;
		const time = age - start;
		if (time < 0 || time > 2.6) continue;
		const random = flightNoise(seed + piece * 13);
		const velocityX = (random - 0.5) * (collapsing ? 100 : 150);
		const velocityY = -25 - flightNoise(seed + piece * 7) * (collapsing ? 60 : 100);
		const x = originX + velocityX * time;
		const rawY = originY + velocityY * time + 125 * time * time;
		const y = Math.min(floor - 2, rawY);
		const size = 2 + flightNoise(seed + piece * 3) * (collapsing ? 5 : 3);
		context.save();
		context.globalAlpha = clamp((2.6 - time) / 0.7) * 0.75;
		context.fillStyle = collapsing ? colors.line : piece % 3 === 0 ? colors.plane : colors.wing;
		context.translate(x, y);
		context.rotate(rawY > floor ? random * 2 : time * (random - 0.5) * 7);
		context.fillRect(-size / 2, -size / 2, size, size * 0.7);
		context.restore();
	}
}

function aftermath(
	context: CanvasRenderingContext2D,
	tower: Tower,
	damage: TowerDamage,
	scene: FlightScene,
	colors: FlightPalette,
) {
	const age = scene.time - damage.started;
	const collapseAge = age - damage.delay;
	const progress = collapseProgress(damage, scene.time);
	const floor = scene.height - 45;
	const x = tower.x - scene.time * flightSpeed + tower.width / 2;
	const hitY = tower.roof + (floor - tower.roof) * damage.hitRatio;
	context.save();
	if (age < 0.28) {
		context.globalAlpha = (1 - age / 0.28) * 0.55;
		context.fillStyle = "#e5aa62";
		cloud(context, x, hitY, 18 + age * 80);
	}
	if (progress < 0.5) {
		for (let flame = 0; flame < 4; flame++) {
			const flicker = flightNoise(damage.seed + flame * 17 + Math.floor(scene.time * 9));
			context.globalAlpha = (0.3 + flicker * 0.25) * (1 - progress * 2);
			context.fillStyle = flame % 2 ? "#ca7340" : "#dca85f";
			context.fillRect(x - 10 + flame * 6, hitY - 4 - flicker * 7, 3, 5 + flicker * 6);
		}
	}
	fragments(context, x, hitY, floor, age, damage.seed, colors, false);
	if (collapseAge > 0) {
		fragments(
			context,
			x,
			hitY + (floor - hitY) * 0.3,
			floor,
			collapseAge,
			damage.seed + 70,
			colors,
			true,
		);
	}
	// Persistent plumes are emitted from the damaged floors, following the sinking structure.
	const lifetime = 3.8;
	for (let puff = 0; puff < 16; puff++) {
		const offset = puff * 0.17;
		const birth = Math.floor((age - offset) / lifetime) * lifetime + offset;
		if (birth < 0 || birth > damage.delay + collapseDuration) continue;
		const time = age - birth;
		const birthProgress = clamp((birth - damage.delay) / collapseDuration);
		const originY = hitY + (floor - hitY) * birthProgress * 0.8;
		const wind = 9 + flightNoise(damage.seed + puff) * 9;
		const spread = 13 + time * 13;
		const drift = Math.sin(puff * 2.3) * time * 6;
		context.globalAlpha = Math.sin((time / lifetime) * Math.PI) * 0.35;
		context.fillStyle = puff % 3 === 0 ? colors.dust : colors.smoke;
		cloud(context, x + wind * time + drift, originY - time * 30, spread);
	}
	// Dust rolls out along the ground, then thins out to reveal the persistent rubble.
	if (collapseAge > 0.55 && collapseAge < 6) {
		const time = collapseAge - 0.55;
		for (let puff = 0; puff < 11; puff++) {
			const side = puff % 2 ? -1 : 1;
			const spread = 16 + Math.min(time, 3) * 14;
			const travel = side * time * (10 + flightNoise(puff + damage.seed) * 18);
			context.globalAlpha = Math.min(1, time * 2) * clamp((5.45 - time) / 3) * 0.21;
			context.fillStyle = colors.dust;
			cloud(context, x + travel, floor - 5 - (puff % 3) * 6, spread);
		}
	}
	context.restore();
}

function plane(
	context: CanvasRenderingContext2D,
	flyer: Flyer,
	scene: FlightScene,
	colors: FlightPalette,
) {
	const distance = scene.time * flightSpeed;
	context.save();
	context.strokeStyle = colors.plane;
	context.lineWidth = 1;
	for (let index = 1; index < flyer.trail.length; index++) {
		const previous = flyer.trail[index - 1];
		const point = flyer.trail[index];
		context.globalAlpha = clamp(1 - (scene.time - point.time) / 1.2) * 0.16;
		context.beginPath();
		context.moveTo(previous.x - distance, previous.y);
		context.lineTo(point.x - distance, point.y);
		context.stroke();
	}
	context.restore();
	if (flyer.status !== "flying") return;
	const size = flyer.size * (scene.width < 600 ? 0.75 : 1);
	context.save();
	context.globalAlpha = clamp((scene.time - flyer.enteredAt) / 0.8);
	context.translate(scene.width * flyer.position, flyer.y);
	context.rotate(flyer.pitch);
	context.scale(size, size);
	context.translate(-19, -8);
	context.fillStyle = colors.outline;
	context.fillRect(2, 6, 32, 6);
	context.fillRect(0, 5, 5, 5);
	context.fillRect(2, 0, 3, 7);
	context.fillRect(5, 3, 2, 4);
	context.fillRect(33, 7, 4, 4);
	context.fillRect(36, 8, 2, 2);
	context.fillRect(16, 3, 5, 4);
	context.fillRect(14, 0, 4, 5);
	context.fillRect(16, 10, 5, 4);
	context.fillRect(12, 13, 5, 4);
	context.fillStyle = colors.plane;
	context.fillRect(4, 7, 30, 4);
	context.fillRect(34, 8, 3, 2);
	context.fillRect(3, 1, 1, 5);
	context.fillStyle = colors.wing;
	context.fillRect(15, 1, 2, 4);
	context.fillRect(17, 4, 3, 3);
	context.fillRect(17, 10, 3, 3);
	context.fillRect(13, 14, 3, 2);
	context.fillRect(15, 12, 3, 3);
	context.fillStyle = colors.outline;
	context.fillRect(20, 12, 4, 2);
	context.fillRect(21, 3, 4, 2);
	context.fillStyle = "#526975";
	context.fillRect(30, 7, 4, 1);
	for (let x = 9; x < 29; x += 3) context.fillRect(x, 7, 1, 1);
	if ((scene.time + flyer.id * 0.7) % 2.8 < 0.18) {
		context.fillStyle = "#b47768";
		context.fillRect(12, 15, 2, 1);
		context.fillStyle = "#91a991";
		context.fillRect(14, 0, 2, 1);
	}
	context.restore();
}

export function drawFlightScene(
	context: CanvasRenderingContext2D,
	scene: FlightScene,
	colors: FlightPalette,
) {
	const { width, height, time } = scene;
	const distance = time * flightSpeed;
	context.clearRect(0, 0, width, height);
	context.save();
	context.fillStyle = colors.cloud;
	context.globalAlpha = 0.65;
	for (let index = 0; index < 7; index++) {
		const x =
			((((index * 293 - distance * 0.24) % (width + 220)) + width + 220) % (width + 220)) - 110;
		cloud(context, x, height * (0.19 + (index % 3) * 0.24), 65 + (index % 3) * 16);
	}
	context.globalAlpha = 0.22;
	const firstBuilding = Math.floor((distance * 0.3) / 55) - 1;
	for (let index = firstBuilding; index < firstBuilding + Math.ceil(width / 55) + 3; index++) {
		const x = index * 55 - distance * 0.3;
		const buildingHeight = 25 + flightNoise(index * 7) * 70;
		context.fillRect(x, height - 45 - buildingHeight, 35, buildingHeight);
	}
	context.restore();
	context.strokeStyle = colors.line;
	context.lineWidth = 1;
	context.beginPath();
	context.moveTo(0, height - 44.5);
	context.lineTo(width, height - 44.5);
	context.stroke();
	context.fillStyle = colors.line;
	for (let x = -(distance % 24); x < width; x += 24) context.fillRect(x, height - 39, 8, 2);
	const first = Math.floor((distance - 240) / flightSpacing);
	for (let index = first; index <= first + Math.ceil(width / flightSpacing) + 2; index++) {
		const blimp = getBlimp(scene, index);
		if (blimp) campaignBlimp(context, blimp, scene, colors);
		for (const tower of towerGeometry(index, width, height, scene.seed)) {
			building(context, tower, scene.damage.get(tower.key), scene, colors);
		}
	}
	for (const damage of scene.damage.values()) {
		const tower = towerGeometry(damage.index, width, height, scene.seed)[damage.side];
		aftermath(context, tower, damage, scene, colors);
	}
	for (const flyer of scene.flyers) plane(context, flyer, scene, colors);
}
