import type Database from "better-sqlite3";
import type { ProductId, StripePrice, StripeProduct } from "../domain/models.js";
import { insertStripeId } from "./id-sequence.js";

interface ProductRow {
	readonly active: number;
	readonly created_at_ms: number;
	readonly id: string;
	readonly name: string;
}

interface PriceRow {
	readonly active: number;
	readonly created_at_ms: number;
	readonly currency: string;
	readonly id: string;
	readonly product_id: string;
	readonly unit_amount: number;
}

export class CatalogRepository {
	readonly #database: Database.Database;

	constructor(database: Database.Database) {
		this.#database = database;
	}

	createPrice(
		input: Readonly<{
			currency: string;
			id?: string;
			now: Date;
			productId: ProductId;
			unitAmount: number;
		}>,
	): StripePrice {
		const id = insertStripeId(this.#database, "price", input.id, (allocatedId) => {
			this.#database
				.prepare(
					`INSERT INTO prices(id, product_id, currency, unit_amount, active, created_at_ms)
					 VALUES (?, ?, ?, ?, 1, ?)`,
				)
				.run(allocatedId, input.productId, input.currency, input.unitAmount, input.now.getTime());
		});
		return this.getPrice(id);
	}

	createProduct(input: Readonly<{ id?: string; name: string; now: Date }>): StripeProduct {
		const id = insertStripeId(this.#database, "product", input.id, (allocatedId) => {
			this.#database
				.prepare("INSERT INTO products(id, name, active, created_at_ms) VALUES (?, ?, 1, ?)")
				.run(allocatedId, input.name, input.now.getTime());
		});
		return this.getProduct(id);
	}

	findPrice(id: string): StripePrice | undefined {
		const row = this.#database
			.prepare(
				"SELECT id, product_id, currency, unit_amount, active, created_at_ms FROM prices WHERE id = ?",
			)
			.get(id) as PriceRow | undefined;
		return row ? toPrice(row) : undefined;
	}

	findProduct(id: string): StripeProduct | undefined {
		const row = this.#database
			.prepare("SELECT id, name, active, created_at_ms FROM products WHERE id = ?")
			.get(id) as ProductRow | undefined;
		return row ? toProduct(row) : undefined;
	}

	getPrice(id: string): StripePrice {
		const price = this.findPrice(id);
		if (!price) throw new Error(`Stripe price ${id} is missing after persistence.`);
		return price;
	}

	getProduct(id: string): StripeProduct {
		const product = this.findProduct(id);
		if (!product) throw new Error(`Stripe product ${id} is missing after persistence.`);
		return product;
	}

	listPrices(
		input: Readonly<{ afterId?: string; limit: number }> = { limit: 100 },
	): readonly StripePrice[] {
		const rows = (
			input.afterId
				? this.#database
						.prepare(
							`${priceSelect}
							 WHERE o.ordinal > (
								SELECT ordinal FROM resource_creation_order
								WHERE kind = 'price' AND resource_id = ?
							 ) ORDER BY o.ordinal LIMIT ?`,
						)
						.all(input.afterId, input.limit)
				: this.#database.prepare(`${priceSelect} ORDER BY o.ordinal LIMIT ?`).all(input.limit)
		) as PriceRow[];
		return Object.freeze(rows.map(toPrice));
	}

	listProducts(
		input: Readonly<{ afterId?: string; limit: number }> = { limit: 100 },
	): readonly StripeProduct[] {
		const rows = (
			input.afterId
				? this.#database
						.prepare(
							`${productSelect}
							 WHERE o.ordinal > (
								SELECT ordinal FROM resource_creation_order
								WHERE kind = 'product' AND resource_id = ?
							 ) ORDER BY o.ordinal LIMIT ?`,
						)
						.all(input.afterId, input.limit)
				: this.#database.prepare(`${productSelect} ORDER BY o.ordinal LIMIT ?`).all(input.limit)
		) as ProductRow[];
		return Object.freeze(rows.map(toProduct));
	}
}

const priceSelect = `SELECT p.id, p.product_id, p.currency, p.unit_amount, p.active, p.created_at_ms
FROM prices p
JOIN resource_creation_order o ON o.kind = 'price' AND o.resource_id = p.id`;

const productSelect = `SELECT p.id, p.name, p.active, p.created_at_ms
FROM products p
JOIN resource_creation_order o ON o.kind = 'product' AND o.resource_id = p.id`;

function toPrice(row: PriceRow): StripePrice {
	return Object.freeze({
		active: row.active === 1,
		createdAt: new Date(row.created_at_ms),
		currency: row.currency,
		id: row.id,
		productId: row.product_id,
		unitAmount: row.unit_amount,
	});
}

function toProduct(row: ProductRow): StripeProduct {
	return Object.freeze({
		active: row.active === 1,
		createdAt: new Date(row.created_at_ms),
		id: row.id,
		name: row.name,
	});
}
