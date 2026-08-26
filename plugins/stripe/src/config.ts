import { z } from "zod";

type CustomerSeedShape = {
	email: z.ZodOptional<z.ZodEmail>;
	id: z.ZodOptional<z.ZodString>;
	name: z.ZodString;
};

type ProductSeedShape = {
	id: z.ZodOptional<z.ZodString>;
	name: z.ZodString;
};

type PriceSeedShape = {
	currency: z.ZodDefault<z.ZodString>;
	id: z.ZodOptional<z.ZodString>;
	product: z.ZodString;
	unitAmount: z.ZodNumber;
};

type StripeConfigShape = {
	secretKey: z.ZodString;
	webhookSecret: z.ZodString;
	webhookUrl: z.ZodDefault<z.ZodNullable<z.ZodURL>>;
};

type StripeSeedShape = {
	customers: z.ZodDefault<z.ZodArray<z.ZodObject<CustomerSeedShape>>>;
	prices: z.ZodDefault<z.ZodArray<z.ZodObject<PriceSeedShape>>>;
	products: z.ZodDefault<z.ZodArray<z.ZodObject<ProductSeedShape>>>;
};

const customerSeedSchema: z.ZodObject<CustomerSeedShape> = z.object({
	email: z.email().optional(),
	id: z.string().min(1).optional(),
	name: z.string().trim().min(1),
});

const productSeedSchema: z.ZodObject<ProductSeedShape> = z.object({
	id: z.string().min(1).optional(),
	name: z.string().trim().min(1),
});

const priceSeedSchema: z.ZodObject<PriceSeedShape> = z.object({
	currency: z
		.string()
		.regex(/^[a-z]{3}$/)
		.default("usd"),
	id: z.string().min(1).optional(),
	product: z.string().min(1),
	unitAmount: z.number().int().nonnegative(),
});

const stripeConfigSchemaDefinition: z.ZodObject<StripeConfigShape> = z.object({
	secretKey: z.string().startsWith("sk_test_"),
	webhookSecret: z.string().startsWith("whsec_"),
	webhookUrl: z.url().nullable().default(null),
});

const stripeSeedSchemaDefinition: z.ZodObject<StripeSeedShape> = z.object({
	customers: z.array(customerSeedSchema).default([]),
	prices: z.array(priceSeedSchema).default([]),
	products: z.array(productSeedSchema).default([]),
});

export const stripeConfigSchema: typeof stripeConfigSchemaDefinition = stripeConfigSchemaDefinition;
export const stripeSeedSchema: typeof stripeSeedSchemaDefinition = stripeSeedSchemaDefinition;
export type StripeConfig = z.output<typeof stripeConfigSchema>;
export type StripeSeed = z.output<typeof stripeSeedSchema>;
