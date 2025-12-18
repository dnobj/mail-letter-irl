/**
 * Development Environment Sync Script
 *
 * Syncs the development environment from production:
 * 1. Deletes and recreates Neon dev branch from production (main)
 * 2. Exports Username-Password users from production Auth0 tenant
 * 3. Imports users to development Auth0 tenant (preserving user_ids)
 *
 * Usage: npm run dev:sync
 *
 * Required environment variables:
 * - NEON_API_KEY: Neon API key
 * - NEON_PROJECT_ID: Neon project ID
 * - AUTH0_PROD_DOMAIN: Production Auth0 domain
 * - AUTH0_PROD_CLIENT_ID: Production Auth0 M2M client ID
 * - AUTH0_PROD_CLIENT_SECRET: Production Auth0 M2M client secret
 * - AUTH0_DEV_DOMAIN: Development Auth0 domain
 * - AUTH0_DEV_CLIENT_ID: Development Auth0 M2M client ID
 * - AUTH0_DEV_CLIENT_SECRET: Development Auth0 M2M client secret
 */

import dotenv from 'dotenv';
dotenv.config({ path: '.env.dev' });

// Configuration
const NEON_API_KEY = process.env.NEON_API_KEY;
const NEON_PROJECT_ID = process.env.NEON_PROJECT_ID;
const NEON_DEV_BRANCH_NAME = 'dev';

const AUTH0_PROD_DOMAIN = process.env.AUTH0_PROD_DOMAIN;
const AUTH0_PROD_CLIENT_ID = process.env.AUTH0_PROD_CLIENT_ID;
const AUTH0_PROD_CLIENT_SECRET = process.env.AUTH0_PROD_CLIENT_SECRET;

const AUTH0_DEV_DOMAIN = process.env.AUTH0_DEV_DOMAIN;
const AUTH0_DEV_CLIENT_ID = process.env.AUTH0_DEV_CLIENT_ID;
const AUTH0_DEV_CLIENT_SECRET = process.env.AUTH0_DEV_CLIENT_SECRET;

// ============================================================================
// Neon Database Sync
// ============================================================================

interface NeonBranch {
  id: string;
  name: string;
  project_id: string;
  parent_id?: string;
  created_at: string;
}

async function neonRequest(path: string, options: RequestInit = {}): Promise<any> {
  const response = await fetch(`https://console.neon.tech/api/v2${path}`, {
    ...options,
    headers: {
      'Authorization': `Bearer ${NEON_API_KEY}`,
      'Content-Type': 'application/json',
      ...options.headers,
    },
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`Neon API error: ${response.status} ${error}`);
  }

  return response.json();
}

async function listNeonBranches(): Promise<NeonBranch[]> {
  const result = await neonRequest(`/projects/${NEON_PROJECT_ID}/branches`);
  return result.branches;
}

async function deleteNeonBranch(branchId: string): Promise<void> {
  await neonRequest(`/projects/${NEON_PROJECT_ID}/branches/${branchId}`, {
    method: 'DELETE',
  });
}

async function createNeonBranch(name: string, parentBranchId: string): Promise<NeonBranch> {
  const result = await neonRequest(`/projects/${NEON_PROJECT_ID}/branches`, {
    method: 'POST',
    body: JSON.stringify({
      branch: {
        name,
        parent_id: parentBranchId,
      },
      endpoints: [
        {
          type: 'read_write',
        },
      ],
    }),
  });
  return result.branch;
}

async function syncNeonDatabase(): Promise<string | null> {
  console.log('\n📊 Syncing Neon Database...');

  if (!NEON_API_KEY || !NEON_PROJECT_ID) {
    console.log('⚠️  Neon API credentials not configured');
    console.log('   Set NEON_API_KEY and NEON_PROJECT_ID in .env.dev');
    console.log('   Skipping database sync - do this manually in Neon Console');
    return null;
  }

  try {
    // List all branches
    const branches = await listNeonBranches();
    console.log(`   Found ${branches.length} branches`);

    // Find main (production) branch
    const mainBranch = branches.find(b => b.name === 'main');
    if (!mainBranch) {
      throw new Error('Could not find main branch');
    }
    console.log(`   Main branch ID: ${mainBranch.id}`);

    // Find existing dev branch
    const devBranch = branches.find(b => b.name === NEON_DEV_BRANCH_NAME);
    if (devBranch) {
      console.log(`   Deleting existing dev branch: ${devBranch.id}`);
      await deleteNeonBranch(devBranch.id);
      console.log('   ✅ Dev branch deleted');
    }

    // Create new dev branch from main
    console.log('   Creating new dev branch from main...');
    const newBranch = await createNeonBranch(NEON_DEV_BRANCH_NAME, mainBranch.id);
    console.log(`   ✅ New dev branch created: ${newBranch.id}`);

    // Note: The connection string will need to be updated in .env.dev
    console.log('\n   ⚠️  Update DATABASE_URL in .env.dev with the new branch connection string');
    console.log('   Get it from: https://console.neon.tech/');

    return newBranch.id;
  } catch (error) {
    console.error('❌ Neon sync failed:', error);
    throw error;
  }
}

// ============================================================================
// Auth0 User Sync
// ============================================================================

interface Auth0User {
  user_id: string;
  email: string;
  email_verified: boolean;
  name?: string;
  nickname?: string;
  picture?: string;
  created_at: string;
  updated_at: string;
  identities: Array<{
    connection: string;
    provider: string;
    user_id: string;
  }>;
  app_metadata?: Record<string, any>;
  user_metadata?: Record<string, any>;
}

async function getAuth0Token(domain: string, clientId: string, clientSecret: string): Promise<string> {
  const response = await fetch(`https://${domain}/oauth/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      grant_type: 'client_credentials',
      client_id: clientId,
      client_secret: clientSecret,
      audience: `https://${domain}/api/v2/`,
    }),
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`Auth0 token error: ${response.status} ${error}`);
  }

  const result = await response.json();
  return result.access_token;
}

async function auth0Request(domain: string, token: string, path: string, options: RequestInit = {}): Promise<any> {
  const response = await fetch(`https://${domain}/api/v2${path}`, {
    ...options,
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json',
      ...options.headers,
    },
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`Auth0 API error: ${response.status} ${error}`);
  }

  // Handle empty responses
  const text = await response.text();
  return text ? JSON.parse(text) : null;
}

async function exportUsernamePasswordUsers(domain: string, token: string): Promise<Auth0User[]> {
  // Get users from Username-Password-Authentication connection
  // Use pagination for large user counts
  const users: Auth0User[] = [];
  let page = 0;
  const perPage = 100;

  while (true) {
    const result = await auth0Request(
      domain,
      token,
      `/users?q=identities.connection:"Username-Password-Authentication"&search_engine=v3&page=${page}&per_page=${perPage}&include_totals=true`
    );

    users.push(...result.users);

    if (users.length >= result.total || result.users.length < perPage) {
      break;
    }
    page++;
  }

  return users;
}

async function deleteAllUsernamePasswordUsers(domain: string, token: string): Promise<number> {
  const users = await exportUsernamePasswordUsers(domain, token);
  let deleted = 0;

  for (const user of users) {
    try {
      await auth0Request(domain, token, `/users/${encodeURIComponent(user.user_id)}`, {
        method: 'DELETE',
      });
      deleted++;
    } catch (error) {
      console.warn(`   Warning: Could not delete user ${user.user_id}:`, error);
    }
  }

  return deleted;
}

async function importUsers(domain: string, token: string, users: Auth0User[]): Promise<number> {
  let imported = 0;

  for (const user of users) {
    try {
      // Create user with specific user_id to preserve it
      await auth0Request(domain, token, '/users', {
        method: 'POST',
        body: JSON.stringify({
          user_id: user.user_id.replace('auth0|', ''), // Remove prefix for creation
          connection: 'Username-Password-Authentication',
          email: user.email,
          email_verified: user.email_verified,
          name: user.name,
          nickname: user.nickname,
          picture: user.picture,
          app_metadata: user.app_metadata,
          user_metadata: user.user_metadata,
          // Note: We can't import passwords directly
          // Users will need to reset their password on first login
          password: generateTemporaryPassword(),
        }),
      });
      imported++;
    } catch (error: any) {
      // User might already exist
      if (error.message?.includes('409')) {
        console.log(`   User ${user.email} already exists, skipping`);
      } else {
        console.warn(`   Warning: Could not import user ${user.email}:`, error.message);
      }
    }
  }

  return imported;
}

function generateTemporaryPassword(): string {
  // Generate a random password that meets Auth0's requirements
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789!@#$%^&*';
  let password = '';
  for (let i = 0; i < 16; i++) {
    password += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  // Ensure at least one of each required character type
  return password + 'Aa1!';
}

async function syncAuth0Users(): Promise<void> {
  console.log('\n🔐 Syncing Auth0 Users...');

  if (!AUTH0_PROD_DOMAIN || !AUTH0_PROD_CLIENT_ID || !AUTH0_PROD_CLIENT_SECRET) {
    console.log('⚠️  Production Auth0 credentials not configured');
    console.log('   Set AUTH0_PROD_DOMAIN, AUTH0_PROD_CLIENT_ID, AUTH0_PROD_CLIENT_SECRET');
    console.log('   Skipping user sync');
    return;
  }

  if (!AUTH0_DEV_DOMAIN || !AUTH0_DEV_CLIENT_ID || !AUTH0_DEV_CLIENT_SECRET) {
    console.log('⚠️  Development Auth0 credentials not configured');
    console.log('   Set AUTH0_DEV_DOMAIN, AUTH0_DEV_CLIENT_ID, AUTH0_DEV_CLIENT_SECRET');
    console.log('   Skipping user sync');
    return;
  }

  try {
    // Get tokens for both tenants
    console.log('   Getting Auth0 tokens...');
    const prodToken = await getAuth0Token(AUTH0_PROD_DOMAIN, AUTH0_PROD_CLIENT_ID, AUTH0_PROD_CLIENT_SECRET);
    const devToken = await getAuth0Token(AUTH0_DEV_DOMAIN, AUTH0_DEV_CLIENT_ID, AUTH0_DEV_CLIENT_SECRET);

    // Export users from production
    console.log('   Exporting Username-Password users from production...');
    const users = await exportUsernamePasswordUsers(AUTH0_PROD_DOMAIN, prodToken);
    console.log(`   Found ${users.length} Username-Password users`);

    if (users.length === 0) {
      console.log('   No Username-Password users to sync');
      console.log('   ✅ Social login users will automatically have matching IDs');
      return;
    }

    // Clear existing users in dev
    console.log('   Clearing existing Username-Password users in dev...');
    const deleted = await deleteAllUsernamePasswordUsers(AUTH0_DEV_DOMAIN, devToken);
    console.log(`   Deleted ${deleted} users from dev`);

    // Import users to dev
    console.log('   Importing users to dev...');
    const imported = await importUsers(AUTH0_DEV_DOMAIN, devToken, users);
    console.log(`   ✅ Imported ${imported} users`);

    console.log('\n   ⚠️  Note: Username-Password users will need to reset their passwords');
    console.log('   Social login users (Google, GitHub, etc.) work automatically');
  } catch (error) {
    console.error('❌ Auth0 sync failed:', error);
    throw error;
  }
}

// ============================================================================
// Main
// ============================================================================

async function main() {
  console.log('🚀 Letter IRL - Development Environment Sync');
  console.log('============================================\n');
  console.log('This script syncs the development environment from production:');
  console.log('1. Recreates Neon dev branch from production');
  console.log('2. Syncs Username-Password users from Auth0 production to dev');
  console.log('');

  try {
    // Sync Neon database
    await syncNeonDatabase();

    // Sync Auth0 users
    await syncAuth0Users();

    console.log('\n✅ Sync complete!');
    console.log('\nNext steps:');
    console.log('1. Update DATABASE_URL in .env.dev if Neon branch was recreated');
    console.log('2. Restart your dev server: npm run dev:env');
    console.log('3. Username-Password users may need to reset their passwords');
  } catch (error) {
    console.error('\n❌ Sync failed:', error);
    process.exit(1);
  }
}

main();
