import { Vector3 } from "three";

class CWBVHNode {

	constructor() {

		this.boundsMin = new Vector3();
		this.boundsMax = new Vector3();
		this.leftChild = null;
		this.rightChild = null;
		this.triangleOffset = 0;
		this.triangleCount = 0;

	}

}

// Helper class for better cache locality and performance
class TriangleInfo {

	constructor( triangle, index ) {

		this.triangle = triangle;
		this.index = index;
		// Pre-compute centroid for better performance
		this.centroid = new Vector3(
			( triangle.posA.x + triangle.posB.x + triangle.posC.x ) / 3,
			( triangle.posA.y + triangle.posB.y + triangle.posC.y ) / 3,
			( triangle.posA.z + triangle.posB.z + triangle.posC.z ) / 3
		);
		// Pre-compute bounds
		this.bounds = {
			min: new Vector3(
				Math.min( triangle.posA.x, triangle.posB.x, triangle.posC.x ),
				Math.min( triangle.posA.y, triangle.posB.y, triangle.posC.y ),
				Math.min( triangle.posA.z, triangle.posB.z, triangle.posC.z )
			),
			max: new Vector3(
				Math.max( triangle.posA.x, triangle.posB.x, triangle.posC.x ),
				Math.max( triangle.posA.y, triangle.posB.y, triangle.posC.y ),
				Math.max( triangle.posA.z, triangle.posB.z, triangle.posC.z )
			)
		};
		// Morton code will be computed later during sorting
		this.mortonCode = 0;

	}

}

export default class BVHBuilder {

	constructor() {

		this.useWorker = true;
		this.maxLeafSize = 8; // Slightly larger for better performance
		this.numBins = 32; // Base number of bins (will be adapted)
		this.minBins = 8; // Minimum bins for sparse nodes
		this.maxBins = 64; // Maximum bins for dense nodes
		this.nodes = [];
		this.totalNodes = 0;
		this.processedTriangles = 0;
		this.totalTriangles = 0;
		this.lastProgressUpdate = 0;
		this.progressUpdateInterval = 100;

		// SAH constants for better quality
		this.traversalCost = 1.0;
		this.intersectionCost = 1.0;

		// Morton code clustering settings
		this.useMortonCodes = true; // Enable spatial clustering
		this.mortonBits = 10; // Precision for Morton codes (10 bits per axis = 30 total)
		this.mortonClusterThreshold = 128; // Use Morton clustering for nodes with more triangles

		// Fallback method configuration
		this.enableObjectMedianFallback = true;
		this.enableSpatialMedianFallback = true;

		// Temporary arrays to avoid allocations
		this.tempLeftTris = [];
		this.tempRightTris = [];
		this.binBounds = [];
		this.binCounts = [];

		// Split method statistics
		this.splitStats = {
			sahSplits: 0,
			objectMedianSplits: 0,
			spatialMedianSplits: 0,
			failedSplits: 0,
			avgBinsUsed: 0,
			totalSplitAttempts: 0,
			mortonSortTime: 0,
			totalBuildTime: 0
		};

		// Pre-allocate maximum bin arrays to avoid reallocations
		this.initializeBinArrays();

	}

	initializeBinArrays() {

		// Pre-allocate for maximum bins to avoid reallocations
		for ( let i = 0; i < this.maxBins; i ++ ) {

			this.binBounds[ i ] = {
				min: new Vector3(),
				max: new Vector3()
			};
			this.binCounts[ i ] = 0;

		}

	}

	getOptimalBinCount( triangleCount ) {

		// Adaptive bin count based on triangle density
		// More triangles = more bins for better quality
		// Fewer triangles = fewer bins for better performance

		if ( triangleCount <= 16 ) {

			return this.minBins; // 8 bins for very sparse nodes

		} else if ( triangleCount <= 64 ) {

			return 16; // Medium bin count for moderate density

		} else if ( triangleCount <= 256 ) {

			return 32; // Standard bin count

		} else if ( triangleCount <= 1024 ) {

			return 48; // Higher bin count for dense nodes

		} else {

			return this.maxBins; // Maximum bins for very dense nodes

		}

	}

	// Configuration method for fine-tuning adaptive behavior
	setAdaptiveBinConfig( config ) {

		if ( config.minBins !== undefined ) this.minBins = Math.max( 4, config.minBins );
		if ( config.maxBins !== undefined ) this.maxBins = Math.min( 128, config.maxBins );
		if ( config.baseBins !== undefined ) this.numBins = config.baseBins;

		// Re-initialize bin arrays if max bins changed
		if ( config.maxBins !== undefined ) {

			this.binBounds = [];
			this.binCounts = [];
			this.initializeBinArrays();

		}

		console.log( 'Adaptive bin config updated:', {
			minBins: this.minBins,
			maxBins: this.maxBins,
			baseBins: this.numBins
		} );

	}

	// Configuration for Morton code clustering
	setMortonConfig( config ) {

		if ( config.enabled !== undefined ) this.useMortonCodes = config.enabled;
		if ( config.bits !== undefined ) this.mortonBits = Math.max( 6, Math.min( 16, config.bits ) );
		if ( config.threshold !== undefined ) this.mortonClusterThreshold = Math.max( 16, config.threshold );

		console.log( 'Morton code config updated:', {
			enabled: this.useMortonCodes,
			bits: this.mortonBits,
			threshold: this.mortonClusterThreshold
		} );

	}

	// Configuration for fallback split methods
	setFallbackConfig( config ) {

		if ( config.objectMedian !== undefined ) this.enableObjectMedianFallback = config.objectMedian;
		if ( config.spatialMedian !== undefined ) this.enableSpatialMedianFallback = config.spatialMedian;

		console.log( 'Fallback config updated:', {
			objectMedianEnabled: this.enableObjectMedianFallback,
			spatialMedianEnabled: this.enableSpatialMedianFallback
		} );

	}

	// Morton code computation functions
	// Expands a 10-bit integer by inserting 2 zeros after each bit
	expandBits( value ) {

		value = ( value * 0x00010001 ) & 0xFF0000FF;
		value = ( value * 0x00000101 ) & 0x0F00F00F;
		value = ( value * 0x00000011 ) & 0xC30C30C3;
		value = ( value * 0x00000005 ) & 0x49249249;
		return value;

	}

	// Computes Morton code for normalized 3D coordinates (0-1023 range)
	morton3D( x, y, z ) {

		return ( this.expandBits( z ) << 2 ) + ( this.expandBits( y ) << 1 ) + this.expandBits( x );

	}

	// How Morton codes work:
	// Triangle centroids:
	// Morton codes preserve spatial proximity:
	//   (1,1,1) → 0b001001001  ┌─────┬─────┐  Nearby triangles get similar
	//   (1,1,2) → 0b001001010  │  A  │  B  │  codes and end up adjacent
	//   (1,2,1) → 0b001010001  ├─────┼─────┤  in the sorted array
	//   (2,1,1) → 0b010001001  │  C  │  D  │
	//                          └─────┴─────┘  Better cache locality!

	// Compute Morton code for a triangle centroid
	computeMortonCode( centroid, sceneMin, sceneMax ) {

		// Normalize coordinates to [0, 1] range
		const range = sceneMax.clone().sub( sceneMin );
		const normalized = centroid.clone().sub( sceneMin );

		// Avoid division by zero
		if ( range.x > 0 ) normalized.x /= range.x;
		if ( range.y > 0 ) normalized.y /= range.y;
		if ( range.z > 0 ) normalized.z /= range.z;

		// Clamp to [0, 1] and scale to Morton space
		const mortonScale = ( 1 << this.mortonBits ) - 1;
		const x = Math.max( 0, Math.min( mortonScale, Math.floor( normalized.x * mortonScale ) ) );
		const y = Math.max( 0, Math.min( mortonScale, Math.floor( normalized.y * mortonScale ) ) );
		const z = Math.max( 0, Math.min( mortonScale, Math.floor( normalized.z * mortonScale ) ) );

		return this.morton3D( x, y, z );

	}

	// Sort triangles by Morton code for better spatial locality
	sortTrianglesByMortonCode( triangleInfos ) {

		if ( ! this.useMortonCodes || triangleInfos.length < this.mortonClusterThreshold ) {

			return triangleInfos; // Skip Morton sorting for small arrays

		}

		const startTime = performance.now();

		// Compute scene bounds
		const sceneMin = new Vector3( Infinity, Infinity, Infinity );
		const sceneMax = new Vector3( - Infinity, - Infinity, - Infinity );

		for ( const triInfo of triangleInfos ) {

			sceneMin.min( triInfo.centroid );
			sceneMax.max( triInfo.centroid );

		}

		// Compute Morton codes for all triangles
		for ( const triInfo of triangleInfos ) {

			triInfo.mortonCode = this.computeMortonCode( triInfo.centroid, sceneMin, sceneMax );

		}

		// Sort by Morton code
		triangleInfos.sort( ( a, b ) => a.mortonCode - b.mortonCode );

		// Track timing
		this.splitStats.mortonSortTime += performance.now() - startTime;

		return triangleInfos;

	}

	// Advanced recursive Morton clustering for extremely large datasets
	recursiveMortonCluster( triangleInfos, maxClusterSize = 10000 ) {

		if ( triangleInfos.length <= maxClusterSize ) {

			return this.sortTrianglesByMortonCode( triangleInfos );

		}

		// For very large datasets, cluster recursively
		const startTime = performance.now();

		// Compute scene bounds
		const sceneMin = new Vector3( Infinity, Infinity, Infinity );
		const sceneMax = new Vector3( - Infinity, - Infinity, - Infinity );

		for ( const triInfo of triangleInfos ) {

			sceneMin.min( triInfo.centroid );
			sceneMax.max( triInfo.centroid );

		}

		// Use coarser Morton codes for initial clustering
		const coarseBits = Math.max( 6, this.mortonBits - 2 );

		// Group triangles by coarse Morton codes
		const clusters = new Map();
		for ( const triInfo of triangleInfos ) {

			// Compute coarse Morton code
			const range = sceneMax.clone().sub( sceneMin );
			const normalized = triInfo.centroid.clone().sub( sceneMin );

			if ( range.x > 0 ) normalized.x /= range.x;
			if ( range.y > 0 ) normalized.y /= range.y;
			if ( range.z > 0 ) normalized.z /= range.z;

			const mortonScale = ( 1 << coarseBits ) - 1;
			const x = Math.max( 0, Math.min( mortonScale, Math.floor( normalized.x * mortonScale ) ) );
			const y = Math.max( 0, Math.min( mortonScale, Math.floor( normalized.y * mortonScale ) ) );
			const z = Math.max( 0, Math.min( mortonScale, Math.floor( normalized.z * mortonScale ) ) );

			const coarseMorton = this.morton3D( x, y, z );

			if ( ! clusters.has( coarseMorton ) ) {

				clusters.set( coarseMorton, [] );

			}

			clusters.get( coarseMorton ).push( triInfo );

		}

		// Sort clusters by Morton code and refine each cluster
		const sortedClusters = Array.from( clusters.entries() ).sort( ( a, b ) => a[ 0 ] - b[ 0 ] );
		const result = [];

		for ( const [ mortonCode, cluster ] of sortedClusters ) {

			// Recursively sort each cluster
			const sortedCluster = this.sortTrianglesByMortonCode( cluster );
			result.push( ...sortedCluster );

		}

		this.splitStats.mortonSortTime += performance.now() - startTime;
		return result;

	}

	// Benchmark method to compare with/without Morton codes
	async benchmarkMortonCodes( triangles, depth = 30, iterations = 3 ) {

		console.log( '🚀 Benchmarking Morton Code Performance...' );

		const originalSetting = this.useMortonCodes;
		const results = {};

		// Test without Morton codes
		this.useMortonCodes = false;
		const withoutMortonTimes = [];

		for ( let i = 0; i < iterations; i ++ ) {

			const start = performance.now();
			await this.build( triangles, depth );
			withoutMortonTimes.push( performance.now() - start );

		}

		// Test with Morton codes
		this.useMortonCodes = true;
		const withMortonTimes = [];

		for ( let i = 0; i < iterations; i ++ ) {

			const start = performance.now();
			await this.build( triangles, depth );
			withMortonTimes.push( performance.now() - start );

		}

		// Calculate statistics
		const avgWithout = withoutMortonTimes.reduce( ( a, b ) => a + b ) / iterations;
		const avgWith = withMortonTimes.reduce( ( a, b ) => a + b ) / iterations;
		const speedup = avgWithout / avgWith;

		results.withoutMorton = {
			times: withoutMortonTimes,
			average: Math.round( avgWithout ),
			trianglesPerSecond: Math.round( triangles.length / ( avgWithout / 1000 ) )
		};

		results.withMorton = {
			times: withMortonTimes,
			average: Math.round( avgWith ),
			trianglesPerSecond: Math.round( triangles.length / ( avgWith / 1000 ) )
		};

		results.improvement = {
			speedupFactor: Math.round( speedup * 100 ) / 100,
			timeReduction: Math.round( ( 1 - 1 / speedup ) * 100 ),
			absoluteTimeSaved: Math.round( avgWithout - avgWith )
		};

		console.log( '📊 Morton Code Benchmark Results:', results );

		// Restore original setting
		this.useMortonCodes = originalSetting;

		return results;

	}

	// Test the robustness of the 3-tier fallback system
	testFallbackRobustness() {

		console.log( '🔧 Testing BVH Fallback System Robustness...' );

		const testCases = [
			{
				name: 'Normal case (should use SAH)',
				triangles: this.generateTestTriangles( 'normal', 100 )
			},
			{
				name: 'Axis-aligned grid (may use object median)',
				triangles: this.generateTestTriangles( 'grid', 64 )
			},
			{
				name: 'All centroids identical (should use spatial median)',
				triangles: this.generateTestTriangles( 'identical_centroids', 32 )
			},
			{
				name: 'Degenerate thin plane (spatial median fallback)',
				triangles: this.generateTestTriangles( 'thin_plane', 50 )
			}
		];

		const results = {};

		for ( const testCase of testCases ) {

			console.log( `Testing: ${testCase.name}` );

			// Reset stats
			this.splitStats = {
				sahSplits: 0,
				objectMedianSplits: 0,
				spatialMedianSplits: 0,
				failedSplits: 0,
				avgBinsUsed: 0,
				totalSplitAttempts: 0,
				mortonSortTime: 0,
				totalBuildTime: 0
			};

			// Build BVH for test case
			try {

				const bvh = this.buildSync( testCase.triangles, 10, [] );

				results[ testCase.name ] = {
					success: true,
					splitMethods: {
						SAH: this.splitStats.sahSplits,
						objectMedian: this.splitStats.objectMedianSplits,
						spatialMedian: this.splitStats.spatialMedianSplits,
						failed: this.splitStats.failedSplits
					},
					totalNodes: this.totalNodes,
					primaryMethod: this.splitStats.sahSplits > 0 ? 'SAH' :
						this.splitStats.objectMedianSplits > 0 ? 'Object Median' :
							this.splitStats.spatialMedianSplits > 0 ? 'Spatial Median' : 'Failed'
				};

			} catch ( error ) {

				results[ testCase.name ] = {
					success: false,
					error: error.message
				};

			}

		}

		console.log( '📊 Fallback System Test Results:', results );
		return results;

	}

	// Generate test triangles for various challenging scenarios
	generateTestTriangles( type, count ) {

		const triangles = [];

		switch ( type ) {

			case 'normal':
				// Random triangles in a cube
				for ( let i = 0; i < count; i ++ ) {

					const base = {
						x: ( Math.random() - 0.5 ) * 10,
						y: ( Math.random() - 0.5 ) * 10,
						z: ( Math.random() - 0.5 ) * 10
					};

					triangles.push( {
						posA: { x: base.x, y: base.y, z: base.z },
						posB: { x: base.x + Math.random(), y: base.y + Math.random(), z: base.z + Math.random() },
						posC: { x: base.x + Math.random(), y: base.y + Math.random(), z: base.z + Math.random() }
					} );

				}

				break;

			case 'grid':
				// Regular grid pattern (challenges SAH)
				const gridSize = Math.ceil( Math.sqrt( count ) );
				for ( let i = 0; i < gridSize; i ++ ) {

					for ( let j = 0; j < gridSize && triangles.length < count; j ++ ) {

						const x = i * 2;
						const z = j * 2;
						triangles.push( {
							posA: { x: x, y: 0, z: z },
							posB: { x: x + 1, y: 0, z: z },
							posC: { x: x, y: 0, z: z + 1 }
						} );

					}

				}

				break;

			case 'identical_centroids':
				// All triangles have the same centroid (challenges object median)
				for ( let i = 0; i < count; i ++ ) {

					const offset = Math.random() * 0.1;
					triangles.push( {
						posA: { x: - offset, y: - offset, z: - offset },
						posB: { x: offset, y: - offset, z: offset },
						posC: { x: 0, y: offset, z: 0 }
					} );

				}

				break;

			case 'thin_plane':
				// Very thin plane (challenges all methods)
				for ( let i = 0; i < count; i ++ ) {

					const x = ( Math.random() - 0.5 ) * 10;
					const z = ( Math.random() - 0.5 ) * 10;
					const y = Math.random() * 0.001; // Very thin

					triangles.push( {
						posA: { x: x, y: y, z: z },
						posB: { x: x + 0.1, y: y, z: z },
						posC: { x: x, y: y, z: z + 0.1 }
					} );

				}

				break;

		}

		return triangles;

	}

	build( triangles, depth = 30, progressCallback = null ) {

		this.totalTriangles = triangles.length;
		this.processedTriangles = 0;
		this.lastProgressUpdate = performance.now();

		if ( this.useWorker && typeof Worker !== 'undefined' ) {

			console.log( "Using Worker" );
			return new Promise( ( resolve, reject ) => {

				try {

					const worker = new Worker(
						new URL( './Workers/BVHWorker.js', import.meta.url ),
						{ type: 'module' }
					);

					worker.onmessage = ( e ) => {

						const { bvhRoot, triangles: newTriangles, error, progress } = e.data;

						if ( error ) {

							worker.terminate();
							reject( new Error( error ) );
							return;

						}

						if ( progress !== undefined && progressCallback ) {

							progressCallback( progress );
							return;

						}

						triangles.length = newTriangles.length;
						for ( let i = 0; i < newTriangles.length; i ++ ) {

							triangles[ i ] = newTriangles[ i ];

						}

						worker.terminate();
						resolve( bvhRoot );

					};

					worker.onerror = ( error ) => {

						worker.terminate();
						reject( error );

					};

					worker.postMessage( { triangles, depth, reportProgress: !! progressCallback } );

				} catch ( error ) {

					console.warn( 'Worker creation failed, falling back to synchronous build:', error );
					resolve( this.buildSync( triangles, depth, [], progressCallback ) );

				}

			} );

		} else {

			return Promise.resolve( this.buildSync( triangles, depth, [], progressCallback ) );

		}

	}

	buildSync( triangles, depth = 30, reorderedTriangles = [], progressCallback = null ) {

		const buildStartTime = performance.now();

		// Reset state
		this.nodes = [];
		this.totalNodes = 0;
		this.processedTriangles = 0;
		this.totalTriangles = triangles.length;
		this.lastProgressUpdate = performance.now();

		// Reset split statistics
		this.splitStats = {
			sahSplits: 0,
			objectMedianSplits: 0,
			spatialMedianSplits: 0,
			failedSplits: 0,
			avgBinsUsed: 0,
			totalSplitAttempts: 0,
			mortonSortTime: 0,
			totalBuildTime: 0
		};

		// Convert to TriangleInfo for better performance
		let triangleInfos = triangles.map( ( tri, index ) => new TriangleInfo( tri, index ) );

		// Apply Morton code spatial clustering for better cache locality
		// Use recursive clustering for very large datasets
		if ( triangleInfos.length > 50000 ) {

			triangleInfos = this.recursiveMortonCluster( triangleInfos );

		} else {

			triangleInfos = this.sortTrianglesByMortonCode( triangleInfos );

		}

		// Create root node
		const root = this.buildNodeRecursive( triangleInfos, depth, reorderedTriangles, progressCallback );

		// Record total build time
		this.splitStats.totalBuildTime = performance.now() - buildStartTime;

		console.log( 'BVH Statistics:', {
			totalNodes: this.totalNodes,
			triangleCount: reorderedTriangles.length,
			maxDepth: depth,
			splitMethods: {
				SAH: this.splitStats.sahSplits,
				objectMedian: this.splitStats.objectMedianSplits,
				spatialMedian: this.splitStats.spatialMedianSplits,
				failed: this.splitStats.failedSplits
			},
			adaptiveBins: {
				averageBinsUsed: Math.round( this.splitStats.avgBinsUsed * 10 ) / 10,
				minBins: this.minBins,
				maxBins: this.maxBins,
				baseBins: this.numBins
			},
			performance: {
				totalBuildTime: Math.round( this.splitStats.totalBuildTime ),
				mortonSortTime: Math.round( this.splitStats.mortonSortTime ),
				mortonSortPercentage: Math.round( ( this.splitStats.mortonSortTime / this.splitStats.totalBuildTime ) * 100 ),
				trianglesPerSecond: Math.round( triangles.length / ( this.splitStats.totalBuildTime / 1000 ) )
			},
			mortonClustering: {
				enabled: this.useMortonCodes,
				threshold: this.mortonClusterThreshold,
				bits: this.mortonBits
			}
		} );

		if ( progressCallback ) {

			progressCallback( 100 );

		}

		return root;

	}

	updateProgress( trianglesProcessed, progressCallback ) {

		if ( ! progressCallback ) return;

		this.processedTriangles += trianglesProcessed;

		const now = performance.now();
		if ( now - this.lastProgressUpdate < this.progressUpdateInterval ) {

			return;

		}

		this.lastProgressUpdate = now;
		const progress = Math.min( Math.floor( ( this.processedTriangles / this.totalTriangles ) * 100 ), 99 );
		progressCallback( progress );

	}

	buildNodeRecursive( triangleInfos, depth, reorderedTriangles, progressCallback ) {

		const node = new CWBVHNode();
		this.nodes.push( node );
		this.totalNodes ++;

		// Update bounds using pre-computed triangle bounds
		this.updateNodeBoundsOptimized( node, triangleInfos );

		// Check for leaf conditions
		if ( triangleInfos.length <= this.maxLeafSize || depth <= 0 ) {

			node.triangleOffset = reorderedTriangles.length;
			node.triangleCount = triangleInfos.length;

			// Add original triangles to reordered array
			for ( const triInfo of triangleInfos ) {

				reorderedTriangles.push( triInfo.triangle );

			}

			this.updateProgress( triangleInfos.length, progressCallback );
			return node;

		}

		// Find split position using improved SAH
		const splitInfo = this.findBestSplitPositionSAH( triangleInfos, node );

		if ( ! splitInfo.success ) {

			// Track failed splits
			this.splitStats.failedSplits ++;

			// Make a leaf node if split failed
			node.triangleOffset = reorderedTriangles.length;
			node.triangleCount = triangleInfos.length;

			for ( const triInfo of triangleInfos ) {

				reorderedTriangles.push( triInfo.triangle );

			}

			this.updateProgress( triangleInfos.length, progressCallback );
			return node;

		}

		// Track successful split method
		if ( splitInfo.method === 'SAH' ) {

			this.splitStats.sahSplits ++;

		} else if ( splitInfo.method === 'object_median' ) {

			this.splitStats.objectMedianSplits ++;

		} else if ( splitInfo.method === 'spatial_median' ) {

			this.splitStats.spatialMedianSplits ++;

		}

		// Partition triangles efficiently
		const { left: leftTris, right: rightTris } = this.partitionTrianglesOptimized(
			triangleInfos,
			splitInfo.axis,
			splitInfo.pos
		);

		// Fall back to leaf if partition failed
		if ( leftTris.length === 0 || rightTris.length === 0 ) {

			node.triangleOffset = reorderedTriangles.length;
			node.triangleCount = triangleInfos.length;

			for ( const triInfo of triangleInfos ) {

				reorderedTriangles.push( triInfo.triangle );

			}

			this.updateProgress( triangleInfos.length, progressCallback );
			return node;

		}

		// Recursively build children
		node.leftChild = this.buildNodeRecursive( leftTris, depth - 1, reorderedTriangles, progressCallback );
		node.rightChild = this.buildNodeRecursive( rightTris, depth - 1, reorderedTriangles, progressCallback );

		return node;

	}

	/**
	 * 3-Tier Robust Split Selection System:
	 *
	 * 1. SAH (Surface Area Heuristic) - Primary method
	 *    - Optimal for most cases, minimizes ray traversal cost
	 *    - Uses adaptive bin counts for quality/performance balance
	 *    - Falls back if no cost-effective split found
	 *
	 * 2. Object Median Split - Secondary fallback
	 *    - Splits at median triangle centroid on longest axis
	 *    - Handles cases where SAH fails (uniform distributions)
	 *    - Falls back if all centroids are identical
	 *
	 * 3. Spatial Median Split - Final fallback
	 *    - Splits at spatial midpoint of triangle bounds
	 *    - Handles extreme degenerate cases (identical centroids)
	 *    - Guarantees a split unless all triangles are identical
	 */
	findBestSplitPositionSAH( triangleInfos, parentNode ) {

		let bestCost = Infinity;
		let bestAxis = - 1;
		let bestPos = 0;

		const parentSA = this.computeSurfaceAreaFromBounds( parentNode.boundsMin, parentNode.boundsMax );
		const leafCost = this.intersectionCost * triangleInfos.length;

		// Use adaptive bin count based on triangle density
		const currentBinCount = this.getOptimalBinCount( triangleInfos.length );

		// Track statistics
		this.splitStats.totalSplitAttempts ++;
		this.splitStats.avgBinsUsed = ( ( this.splitStats.avgBinsUsed * ( this.splitStats.totalSplitAttempts - 1 ) ) + currentBinCount ) / this.splitStats.totalSplitAttempts;

		for ( let axis = 0; axis < 3; axis ++ ) {

			// Find centroid bounds for this axis
			let minCentroid = Infinity;
			let maxCentroid = - Infinity;

			for ( const triInfo of triangleInfos ) {

				const centroid = triInfo.centroid.getComponent( axis );
				minCentroid = Math.min( minCentroid, centroid );
				maxCentroid = Math.max( maxCentroid, centroid );

			}

			if ( maxCentroid - minCentroid < 1e-6 ) continue; // Skip degenerate axis

			// Reset bins (only the ones we're using)
			for ( let i = 0; i < currentBinCount; i ++ ) {

				this.binCounts[ i ] = 0;
				this.binBounds[ i ].min.set( Infinity, Infinity, Infinity );
				this.binBounds[ i ].max.set( - Infinity, - Infinity, - Infinity );

			}

			// Place triangles into bins
			const binScale = currentBinCount / ( maxCentroid - minCentroid );
			for ( const triInfo of triangleInfos ) {

				const centroid = triInfo.centroid.getComponent( axis );
				let binIndex = Math.floor( ( centroid - minCentroid ) * binScale );
				binIndex = Math.min( binIndex, currentBinCount - 1 );

				this.binCounts[ binIndex ] ++;
				this.expandBounds( this.binBounds[ binIndex ], triInfo.bounds );

			}

			// Evaluate splits between bins
			for ( let i = 1; i < currentBinCount; i ++ ) {

				// Count triangles and compute bounds for left side
				let leftCount = 0;
				const leftBounds = {
					min: new Vector3( Infinity, Infinity, Infinity ),
					max: new Vector3( - Infinity, - Infinity, - Infinity )
				};

				for ( let j = 0; j < i; j ++ ) {

					if ( this.binCounts[ j ] > 0 ) {

						leftCount += this.binCounts[ j ];
						this.expandBounds( leftBounds, this.binBounds[ j ] );

					}

				}

				// Count triangles and compute bounds for right side
				let rightCount = 0;
				const rightBounds = {
					min: new Vector3( Infinity, Infinity, Infinity ),
					max: new Vector3( - Infinity, - Infinity, - Infinity )
				};

				for ( let j = i; j < currentBinCount; j ++ ) {

					if ( this.binCounts[ j ] > 0 ) {

						rightCount += this.binCounts[ j ];
						this.expandBounds( rightBounds, this.binBounds[ j ] );

					}

				}

				if ( leftCount === 0 || rightCount === 0 ) continue;

				// Compute SAH cost
				const leftSA = this.computeSurfaceAreaFromBounds( leftBounds.min, leftBounds.max );
				const rightSA = this.computeSurfaceAreaFromBounds( rightBounds.min, rightBounds.max );

				const cost = this.traversalCost +
					( leftSA / parentSA ) * leftCount * this.intersectionCost +
					( rightSA / parentSA ) * rightCount * this.intersectionCost;

				if ( cost < bestCost && cost < leafCost ) {

					bestCost = cost;
					bestAxis = axis;
					bestPos = minCentroid + ( maxCentroid - minCentroid ) * i / currentBinCount;

				}

			}

		}

		// If SAH failed to find a good split, try object median as fallback
		if ( bestAxis === - 1 ) {

			if ( this.enableObjectMedianFallback ) {

				return this.findObjectMedianSplit( triangleInfos );

			} else if ( this.enableSpatialMedianFallback ) {

				return this.findSpatialMedianSplit( triangleInfos );

			} else {

				return { success: false, method: 'fallbacks_disabled' };

			}

		}

		return {
			success: bestAxis !== - 1,
			axis: bestAxis,
			pos: bestPos,
			method: 'SAH',
			binsUsed: currentBinCount
		};

	}

	findObjectMedianSplit( triangleInfos ) {

		let bestAxis = - 1;
		let bestSpread = - 1;

		// Find the axis with the largest spread
		for ( let axis = 0; axis < 3; axis ++ ) {

			let minCentroid = Infinity;
			let maxCentroid = - Infinity;

			for ( const triInfo of triangleInfos ) {

				const centroid = triInfo.centroid.getComponent( axis );
				minCentroid = Math.min( minCentroid, centroid );
				maxCentroid = Math.max( maxCentroid, centroid );

			}

			const spread = maxCentroid - minCentroid;
			if ( spread > bestSpread ) {

				bestSpread = spread;
				bestAxis = axis;

			}

		}

		if ( bestAxis === - 1 || bestSpread < 1e-10 ) {

			// If object median fails, try spatial median as final fallback
			if ( this.enableSpatialMedianFallback ) {

				return this.findSpatialMedianSplit( triangleInfos );

			} else {

				return { success: false, method: 'object_median_failed_no_spatial_fallback' };

			}

		}

		// Sort triangles by centroid on the best axis
		const sortedTriangles = [ ...triangleInfos ];
		sortedTriangles.sort( ( a, b ) => {

			return a.centroid.getComponent( bestAxis ) - b.centroid.getComponent( bestAxis );

		} );

		// Find median position
		const medianIndex = Math.floor( sortedTriangles.length / 2 );
		const medianCentroid = sortedTriangles[ medianIndex ].centroid.getComponent( bestAxis );

		// Ensure we don't get an empty partition by using the actual median triangle's centroid
		// and adjusting slightly if needed
		let splitPos = medianCentroid;

		// Check if this split would create balanced partitions
		let leftCount = 0;
		for ( const triInfo of triangleInfos ) {

			if ( triInfo.centroid.getComponent( bestAxis ) <= splitPos ) {

				leftCount ++;

			}

		}

		// If the split is too unbalanced, adjust it
		if ( leftCount === 0 || leftCount === triangleInfos.length ) {

			// Use the position slightly before the median triangle
			if ( medianIndex > 0 ) {

				const prevCentroid = sortedTriangles[ medianIndex - 1 ].centroid.getComponent( bestAxis );
				splitPos = ( prevCentroid + medianCentroid ) * 0.5;

			} else {

				// Object median failed, try spatial median
				if ( this.enableSpatialMedianFallback ) {

					return this.findSpatialMedianSplit( triangleInfos );

				} else {

					return { success: false, method: 'object_median_degenerate_no_spatial_fallback' };

				}

			}

		}

		return {
			success: true,
			axis: bestAxis,
			pos: splitPos,
			method: 'object_median'
		};

	}

	findSpatialMedianSplit( triangleInfos ) {

		let bestAxis = - 1;
		let bestSpread = - 1;
		let bestBounds = null;

		// Find the axis with the largest spatial spread (based on triangle bounds, not centroids)
		for ( let axis = 0; axis < 3; axis ++ ) {

			let minBound = Infinity;
			let maxBound = - Infinity;

			// Consider all triangle vertices, not just centroids
			for ( const triInfo of triangleInfos ) {

				minBound = Math.min( minBound, triInfo.bounds.min.getComponent( axis ) );
				maxBound = Math.max( maxBound, triInfo.bounds.max.getComponent( axis ) );

			}

			const spread = maxBound - minBound;
			if ( spread > bestSpread ) {

				bestSpread = spread;
				bestAxis = axis;
				bestBounds = { min: minBound, max: maxBound };

			}

		}

		if ( bestAxis === - 1 || bestSpread < 1e-12 ) {

			return { success: false, method: 'spatial_median_failed' };

		}

		// Use spatial median - split at the middle of the bounding box
		const splitPos = ( bestBounds.min + bestBounds.max ) * 0.5;

		// Verify this creates a reasonable split
		let leftCount = 0;
		let rightCount = 0;

		for ( const triInfo of triangleInfos ) {

			const centroid = triInfo.centroid.getComponent( bestAxis );
			if ( centroid <= splitPos ) {

				leftCount ++;

			} else {

				rightCount ++;

			}

		}

		// If still creating degenerate partitions, force a more balanced split
		if ( leftCount === 0 || rightCount === 0 ) {

			// Create array of all centroid values for this axis
			const centroids = triangleInfos.map( tri => tri.centroid.getComponent( bestAxis ) );
			centroids.sort( ( a, b ) => a - b );

			// Use the actual median of centroids as split position
			const medianIndex = Math.floor( centroids.length / 2 );
			const medianCentroid = centroids[ medianIndex ];

			// Ensure we don't have all identical values
			if ( centroids[ 0 ] === centroids[ centroids.length - 1 ] ) {

				return { success: false, method: 'spatial_median_degenerate' };

			}

			// Use position between median values to ensure split
			let adjustedSplitPos = medianCentroid;
			if ( medianIndex > 0 && centroids[ medianIndex - 1 ] !== medianCentroid ) {

				adjustedSplitPos = ( centroids[ medianIndex - 1 ] + medianCentroid ) * 0.5;

			} else if ( medianIndex < centroids.length - 1 ) {

				adjustedSplitPos = ( medianCentroid + centroids[ medianIndex + 1 ] ) * 0.5;

			}

			return {
				success: true,
				axis: bestAxis,
				pos: adjustedSplitPos,
				method: 'spatial_median'
			};

		}

		return {
			success: true,
			axis: bestAxis,
			pos: splitPos,
			method: 'spatial_median'
		};

	}

	partitionTrianglesOptimized( triangleInfos, axis, splitPos ) {

		// Clear temp arrays
		this.tempLeftTris.length = 0;
		this.tempRightTris.length = 0;

		for ( const triInfo of triangleInfos ) {

			const centroid = triInfo.centroid.getComponent( axis );
			if ( centroid <= splitPos ) {

				this.tempLeftTris.push( triInfo );

			} else {

				this.tempRightTris.push( triInfo );

			}

		}

		return {
			left: this.tempLeftTris.slice(), // Copy to avoid reference issues
			right: this.tempRightTris.slice()
		};

	}

	updateNodeBoundsOptimized( node, triangleInfos ) {

		node.boundsMin.set( Infinity, Infinity, Infinity );
		node.boundsMax.set( - Infinity, - Infinity, - Infinity );

		for ( const triInfo of triangleInfos ) {

			node.boundsMin.min( triInfo.bounds.min );
			node.boundsMax.max( triInfo.bounds.max );

		}

	}

	expandBounds( targetBounds, sourceBounds ) {

		targetBounds.min.min( sourceBounds.min );
		targetBounds.max.max( sourceBounds.max );

	}

	computeSurfaceAreaFromBounds( boundsMin, boundsMax ) {

		const dx = boundsMax.x - boundsMin.x;
		const dy = boundsMax.y - boundsMin.y;
		const dz = boundsMax.z - boundsMin.z;
		return 2 * ( dx * dy + dy * dz + dz * dx );

	}

	// Legacy methods for compatibility
	computeBounds( triangles ) {

		const bounds = {
			min: new Vector3( Infinity, Infinity, Infinity ),
			max: new Vector3( - Infinity, - Infinity, - Infinity )
		};

		for ( const tri of triangles ) {

			bounds.min.x = Math.min( bounds.min.x, tri.posA.x, tri.posB.x, tri.posC.x );
			bounds.min.y = Math.min( bounds.min.y, tri.posA.y, tri.posB.y, tri.posC.y );
			bounds.min.z = Math.min( bounds.min.z, tri.posA.z, tri.posB.z, tri.posC.z );

			bounds.max.x = Math.max( bounds.max.x, tri.posA.x, tri.posB.x, tri.posC.x );
			bounds.max.y = Math.max( bounds.max.y, tri.posA.y, tri.posB.y, tri.posC.y );
			bounds.max.z = Math.max( bounds.max.z, tri.posA.z, tri.posB.z, tri.posC.z );

		}

		return bounds;

	}

	computeSurfaceArea( bounds ) {

		const dx = bounds.max.x - bounds.min.x;
		const dy = bounds.max.y - bounds.min.y;
		const dz = bounds.max.z - bounds.min.z;
		return 2 * ( dx * dy + dy * dz + dz * dx );

	}

}
