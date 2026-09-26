import { describe, it, expect, vi, afterEach } from 'vitest';

const { OIDNDenoiser } = await import( '@/core/Passes/OIDNDenoiser.js' );

const renderer = { domElement: { width: 8, height: 8 } };

function stubFetch( ok = true ) {

	const fetch = vi.fn( async () => ( { ok, status: ok ? 200 : 404, arrayBuffer: async () => new ArrayBuffer( 4 ) } ) );
	vi.stubGlobal( 'fetch', fetch );
	return fetch;

}

afterEach( () => vi.unstubAllGlobals() );

describe( 'OIDNDenoiser — model weights', () => {

	// A camera move swaps tiers twice; each swap used to download again.
	it( 'downloads each model once, however often the tier swaps', async () => {

		const fetch = stubFetch();
		const dn = new OIDNDenoiser( renderer );
		const calls = () => fetch.mock.calls.filter( ( [ url ] ) => url === 'a.tza' ).length;

		const first = await dn._fetchWeights( 'a.tza' );
		const again = await dn._fetchWeights( 'a.tza' );

		expect( calls() ).toBe( 1 );
		expect( again ).toBe( first );

	} );

	it( 'tries again after a failed download instead of keeping the failure', async () => {

		const fetch = stubFetch( false );
		const dn = new OIDNDenoiser( renderer );

		await expect( dn._fetchWeights( 'b.tza' ) ).rejects.toThrow( '404' );
		await expect( dn._fetchWeights( 'b.tza' ) ).rejects.toThrow( '404' );

		expect( fetch.mock.calls.filter( ( [ url ] ) => url === 'b.tza' ).length ).toBe( 2 );

	} );

} );
