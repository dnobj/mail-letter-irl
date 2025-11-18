-- Migration 001: Initial Schema for Letter IRL
-- Creates tables for users, credits, orders, letters, and jobs

-- Users and credit balances
CREATE TABLE users (
  user_id VARCHAR(255) PRIMARY KEY,  -- Auth0 user ID like "auth0|123456"
  email VARCHAR(255) NOT NULL UNIQUE,
  credits INTEGER NOT NULL DEFAULT 0 CHECK (credits >= 0),
  credits_purchased INTEGER NOT NULL DEFAULT 0,
  credits_used INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMP NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMP NOT NULL DEFAULT NOW()
);

-- Credit transaction ledger (complete audit trail)
CREATE TABLE credit_transactions (
  transaction_id SERIAL PRIMARY KEY,
  user_id VARCHAR(255) NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
  amount INTEGER NOT NULL,  -- Positive for purchase/refund, negative for use
  balance_after INTEGER NOT NULL,  -- Snapshot of balance after transaction
  type VARCHAR(50) NOT NULL,  -- 'purchase', 'deduction', 'refund', 'adjustment'
  reference_type VARCHAR(50),  -- 'order', 'letter', 'manual'
  reference_id VARCHAR(255),  -- order_id, letter_id, or admin note
  description TEXT,
  created_at TIMESTAMP NOT NULL DEFAULT NOW(),

  CONSTRAINT valid_transaction_type CHECK (type IN ('purchase', 'deduction', 'refund', 'adjustment'))
);

-- Purchase orders (from ACP or other payment methods)
CREATE TABLE orders (
  order_id VARCHAR(255) PRIMARY KEY,
  user_id VARCHAR(255) NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
  credits INTEGER NOT NULL CHECK (credits > 0),
  amount_cents INTEGER NOT NULL CHECK (amount_cents > 0),  -- Stored in cents
  currency VARCHAR(3) NOT NULL DEFAULT 'USD',
  stripe_payment_intent_id VARCHAR(255) UNIQUE,
  status VARCHAR(50) NOT NULL DEFAULT 'pending',
  created_at TIMESTAMP NOT NULL DEFAULT NOW(),
  completed_at TIMESTAMP,

  CONSTRAINT valid_order_status CHECK (status IN ('pending', 'completed', 'failed', 'refunded'))
);

-- Letters (content and metadata)
CREATE TABLE letters (
  letter_id VARCHAR(255) PRIMARY KEY,
  user_id VARCHAR(255) NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
  content JSONB NOT NULL,  -- Full letter content as JSON
  recipient JSONB NOT NULL,  -- Address and recipient info as JSON
  credits_cost INTEGER NOT NULL CHECK (credits_cost > 0),
  status VARCHAR(50) NOT NULL DEFAULT 'draft',
  preview_html TEXT,
  tracking_number VARCHAR(255),
  created_at TIMESTAMP NOT NULL DEFAULT NOW(),
  sent_at TIMESTAMP,

  CONSTRAINT valid_letter_status CHECK (status IN ('draft', 'queued', 'processing', 'sent', 'failed', 'cancelled'))
);

-- Letter processing jobs
CREATE TABLE letter_jobs (
  job_id VARCHAR(255) PRIMARY KEY,
  letter_id VARCHAR(255) NOT NULL REFERENCES letters(letter_id) ON DELETE CASCADE,
  status VARCHAR(50) NOT NULL DEFAULT 'pending',
  attempts INTEGER NOT NULL DEFAULT 0,
  max_attempts INTEGER NOT NULL DEFAULT 3,
  scheduled_at TIMESTAMP NOT NULL DEFAULT NOW(),
  started_at TIMESTAMP,
  completed_at TIMESTAMP,
  error_message TEXT,
  metadata JSONB,  -- For storing job-specific data
  created_at TIMESTAMP NOT NULL DEFAULT NOW(),

  CONSTRAINT valid_job_status CHECK (status IN ('pending', 'processing', 'completed', 'failed', 'cancelled'))
);

-- Indexes for performance
CREATE INDEX idx_users_email ON users(email);
CREATE INDEX idx_users_created_at ON users(created_at);

CREATE INDEX idx_credit_transactions_user_id ON credit_transactions(user_id);
CREATE INDEX idx_credit_transactions_created_at ON credit_transactions(created_at DESC);
CREATE INDEX idx_credit_transactions_type ON credit_transactions(type);

CREATE INDEX idx_orders_user_id ON orders(user_id);
CREATE INDEX idx_orders_status ON orders(status);
CREATE INDEX idx_orders_created_at ON orders(created_at DESC);
CREATE INDEX idx_orders_stripe_payment_intent_id ON orders(stripe_payment_intent_id);

CREATE INDEX idx_letters_user_id ON letters(user_id);
CREATE INDEX idx_letters_status ON letters(status);
CREATE INDEX idx_letters_created_at ON letters(created_at DESC);

CREATE INDEX idx_letter_jobs_status ON letter_jobs(status);
CREATE INDEX idx_letter_jobs_scheduled_at ON letter_jobs(scheduled_at);
CREATE INDEX idx_letter_jobs_letter_id ON letter_jobs(letter_id);

-- Update updated_at timestamp automatically
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ language 'plpgsql';

CREATE TRIGGER update_users_updated_at
  BEFORE UPDATE ON users
  FOR EACH ROW
  EXECUTE FUNCTION update_updated_at_column();

-- Comments for documentation
COMMENT ON TABLE users IS 'User accounts with credit balances';
COMMENT ON TABLE credit_transactions IS 'Complete audit trail of all credit changes';
COMMENT ON TABLE orders IS 'Purchase orders from ACP or other payment methods';
COMMENT ON TABLE letters IS 'Letter content and delivery information';
COMMENT ON TABLE letter_jobs IS 'Background jobs for processing and sending letters';

COMMENT ON COLUMN credit_transactions.balance_after IS 'Snapshot of user credit balance after this transaction (for audit)';
COMMENT ON COLUMN orders.amount_cents IS 'Order amount in cents to avoid floating point issues';
COMMENT ON COLUMN letters.content IS 'JSON: {body, formatting, pages, etc}';
COMMENT ON COLUMN letters.recipient IS 'JSON: {name, address1, city, state, zip, country}';
