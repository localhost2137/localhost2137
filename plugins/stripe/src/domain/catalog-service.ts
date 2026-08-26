import type { StripeDatabase } from "../persistence/database.js";
import type { StripePrice, StripeProduct } from "./models.js";
import { StripeError } from "./stripe-error.js";

export class CatalogService {
	readonly #database: StripeDatabase;

	constructor(database: StripeDatabase) {
		this.#database = database;
	}

	createPrice(
		input: Readonly<{
			currency: string;
			id?: string;
			now: Date;
			productId: string;
			unitAmount: number;
		}>,
	): StripePrice {
		this.requireProduct(input.productId);
		const currency = input.currency.trim().toLowerCase();
		if (!/^[a-z]{3}$/.test(currency)) {
			throw new StripeError(
				"invalid_argument",
				"Price currency must be a lowercase ISO code.",
				"currency",
			);
		}
		if (!Number.isSafeInteger(input.unitAmount) || input.unitAmount < 0) {
			throw new StripeError(
				"invalid_argument",
				"Price unit amount must be a non-negative integer.",
				"unit_amount",
			);
		}
		return this.#database.catalog.createPrice({ ...input, currency });
	}

	createProduct(input: Readonly<{ id?: string; name: string; now: Date }>): StripeProduct {
		const name = input.name.trim();
		if (name.length === 0 || name.length > 200) {
			throw new StripeError(
				"invalid_argument",
				"Product name must contain 1-200 characters.",
				"name",
			);
		}
		return this.#database.catalog.createProduct({ ...input, name });
	}

	listPrices(input?: Readonly<{ afterId?: string; limit: number }>): readonly StripePrice[] {
		if (input?.afterId) this.requirePrice(input.afterId);
		return this.#database.catalog.listPrices(input);
	}

	listProducts(input?: Readonly<{ afterId?: string; limit: number }>): readonly StripeProduct[] {
		if (input?.afterId) this.requireProduct(input.afterId);
		return this.#database.catalog.listProducts(input);
	}

	requirePrice(id: string): StripePrice {
		const price = this.#database.catalog.findPrice(id);
		if (!price) throw new StripeError("price_missing", `No such price: '${id}'.`, "price");
		return price;
	}

	requireProduct(id: string): StripeProduct {
		const product = this.#database.catalog.findProduct(id);
		if (!product) throw new StripeError("product_missing", `No such product: '${id}'.`, "product");
		return product;
	}
}
