import type { StripeConfig, StripeSeed } from "../config.js";
import type { StripeDatabase } from "../persistence/database.js";
import { BillingService } from "./billing-service.js";
import { CatalogService } from "./catalog-service.js";
import { CustomerService } from "./customer-service.js";

export interface StripeServices {
	readonly billing: BillingService;
	readonly catalog: CatalogService;
	readonly customers: CustomerService;
}

export function createStripeServices(
	database: StripeDatabase,
	config: StripeConfig,
): StripeServices {
	const customers = new CustomerService(database);
	const catalog = new CatalogService(database);
	return Object.freeze({
		billing: new BillingService(database, {
			catalog,
			customers,
			emitWebhooks: config.webhookUrl !== null,
		}),
		catalog,
		customers,
	});
}

export function seedStripeServices(services: StripeServices, seed: StripeSeed, now: Date): void {
	for (const customer of seed.customers) {
		services.customers.create({
			...(customer.email ? { email: customer.email } : {}),
			...(customer.id ? { id: customer.id } : {}),
			name: customer.name,
			now,
		});
	}
	for (const product of seed.products) {
		services.catalog.createProduct({
			...(product.id ? { id: product.id } : {}),
			name: product.name,
			now,
		});
	}
	for (const price of seed.prices) {
		services.catalog.createPrice({
			currency: price.currency,
			...(price.id ? { id: price.id } : {}),
			now,
			productId: price.product,
			unitAmount: price.unitAmount,
		});
	}
}
