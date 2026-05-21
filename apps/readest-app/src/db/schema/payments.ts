import {
  pgTable,
  text,
  timestamp,
  uuid,
  integer,
  jsonb,
  boolean,
  index,
  unique,
} from 'drizzle-orm/pg-core';
import { user } from './auth';

export const customers = pgTable(
  'customers',
  {
    userId: text('user_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' })
      .unique(),
    stripeCustomerId: text('stripe_customer_id').notNull().unique(),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
  },
  (t) => [index('idx_customers_user_id').on(t.userId)],
);

export const payments = pgTable(
  'payments',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: text('user_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    provider: text('provider').notNull(), // 'stripe' | 'apple' | 'google'
    amount: integer('amount'),
    currency: text('currency'),
    status: text('status').notNull(),
    paymentMethod: text('payment_method'),
    productId: text('product_id'),
    storageGb: integer('storage_gb').default(0),
    metadata: jsonb('metadata'),
    // Stripe-specific
    stripeCustomerId: text('stripe_customer_id'),
    stripeCheckoutId: text('stripe_checkout_id'),
    stripePaymentIntentId: text('stripe_payment_intent_id').unique(),
    // Apple-specific
    appleTransactionId: text('apple_transaction_id'),
    appleOriginalTransactionId: text('apple_original_transaction_id').unique(),
    // Google-specific
    googleOrderId: text('google_order_id'),
    googlePurchaseToken: text('google_purchase_token').unique(),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow(),
  },
  (t) => [index('idx_payments_user_id').on(t.userId)],
);

export const subscriptions = pgTable(
  'subscriptions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: text('user_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    stripeCustomerId: text('stripe_customer_id'),
    stripeSubscriptionId: text('stripe_subscription_id').unique(),
    stripePriceId: text('stripe_price_id'),
    status: text('status').notNull(),
    currentPeriodStart: timestamp('current_period_start', { withTimezone: true }),
    currentPeriodEnd: timestamp('current_period_end', { withTimezone: true }),
    cancelledAt: timestamp('cancelled_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
  },
  (t) => [index('idx_subscriptions_user_id').on(t.userId)],
);

export const appleIapSubscriptions = pgTable(
  'apple_iap_subscriptions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: text('user_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    platform: text('platform'),
    productId: text('product_id'),
    transactionId: text('transaction_id'),
    originalTransactionId: text('original_transaction_id'),
    status: text('status'),
    purchaseDate: timestamp('purchase_date', { withTimezone: true }),
    expiresDate: timestamp('expires_date', { withTimezone: true }),
    environment: text('environment'),
    bundleId: text('bundle_id'),
    quantity: integer('quantity').default(1),
    autoRenewStatus: boolean('auto_renew_status'),
    webOrderLineItemId: text('web_order_line_item_id'),
    subscriptionGroupIdentifier: text('subscription_group_identifier'),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow(),
  },
  (t) => [
    unique('apple_iap_subscriptions_user_id_original_transaction_id').on(
      t.userId,
      t.originalTransactionId,
    ),
    index('idx_apple_iap_subscriptions_user_id').on(t.userId),
  ],
);

export const googleIapSubscriptions = pgTable(
  'google_iap_subscriptions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: text('user_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    platform: text('platform'),
    productId: text('product_id'),
    purchaseToken: text('purchase_token'),
    orderId: text('order_id'),
    status: text('status'),
    purchaseDate: timestamp('purchase_date', { withTimezone: true }),
    expiresDate: timestamp('expires_date', { withTimezone: true }),
    environment: text('environment'),
    packageName: text('package_name'),
    quantity: integer('quantity').default(1),
    autoRenewStatus: boolean('auto_renew_status'),
    purchaseState: integer('purchase_state'),
    acknowledgementState: integer('acknowledgement_state'),
    priceAmountMicros: text('price_amount_micros'),
    priceCurrencyCode: text('price_currency_code'),
    countryCode: text('country_code'),
    developerPayload: text('developer_payload'),
    linkedPurchaseToken: text('linked_purchase_token'),
    obfuscatedExternalAccountId: text('obfuscated_external_account_id'),
    obfuscatedExternalProfileId: text('obfuscated_external_profile_id'),
    cancelReason: integer('cancel_reason'),
    userCancellationTimeMillis: text('user_cancellation_time_millis'),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow(),
  },
  (t) => [
    unique('google_iap_subscriptions_user_id_order_id').on(t.userId, t.orderId),
    index('idx_google_iap_subscriptions_user_id').on(t.userId),
  ],
);
