import { ItemsCatalog } from '@/components/ui/items-catalog';
import { Separator } from "@/components/ui/separator";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { MODEL_FILES, DEBUG_MODELS } from '../../../Constants';
import { EnvironmentCatalog } from '@/components/ui/env-catalog';
import { useToast } from "@/hooks/use-toast";
import { useAssetsStore } from '@/store';
import { useEffect } from 'react';
import { useStore, useEnvironmentStore } from '@/store';

const AssetsTab = () => {

	const selectedObject = useStore( ( state ) => state.selectedObject );
	const setLoading = useStore( ( state ) => state.setLoading );
	const { toast } = useToast();
	const {
		activeTab,
		model,
		environment,
		debugModel,
		materials,
		selectedMaterial,
		selectedEnvironmentIndex,
		setActiveTab,
		setModel,
		setEnvironment,
		setDebugModel,
		setMaterials,
		setSelectedMaterial,
		setSelectedEnvironmentIndex,
	} = useAssetsStore();

	// Fetch material catalog on component mount
	useEffect( () => {

		const fetchMaterials = async () => {

			try {

				const response = await fetch( 'https://api.physicallybased.info/materials' );
				const data = await response.json();

				const processedMaterials = data.map( ( mData ) => ( {
					...mData,
					preview: mData.reference[ 0 ]
				} ) );

				setMaterials( processedMaterials );

			} catch ( error ) {

				console.error( 'Error fetching materials:', error );
				toast( {
					title: "Error Loading Materials",
					description: "Failed to load material catalog",
					variant: "destructive",
				} );

			}

		};

		fetchMaterials();

	}, [] );

	// Fix for environments - use stored environment index
	const getEnvironmentIndex = () => {

		return selectedEnvironmentIndex !== null && selectedEnvironmentIndex !== undefined
			? selectedEnvironmentIndex.toString()
			: null;

	};

	const handleEnvironmentChange = async ( envData ) => {

		if ( ! envData || ! envData.url ) return;

		// Update both environment and its index
		setEnvironment( envData );

		// Find and set the environment index
		const environmentStore = useEnvironmentStore.getState();
		const environments = environmentStore.environments || [];
		const index = environments.findIndex( env => env.id === envData.id );
		setSelectedEnvironmentIndex( index >= 0 ? index : null );

		if ( ! window.pathTracerApp ) return;

		setLoading( { isLoading: true, title: "Loading", status: "Loading Environment...", progress: 0 } );

		try {

			// Handle custom environment uploads
			if ( envData.id === 'custom-upload' && envData.name ) {

				window.uploadedEnvironmentFileInfo = {
					name: envData.name,
					url: envData.url
				};

			}

			await window.pathTracerApp.loadEnvironment( envData.url );

			toast( {
				title: "Environment Loaded Successfully",
				description: envData.name,
			} );

		} catch ( error ) {

			console.error( "Environment loading error:", error );
			toast( {
				title: "Error Loading Environment",
				description: `${envData.name}: ${error.message || "Unknown error"}`,
				variant: "destructive",
			} );

		} finally {

			window.pathTracerApp.reset();
			setLoading( { isLoading: true, title: "Loading", status: "Loading Environment...", progress: 100 } );
			setTimeout( () => useStore.getState().resetLoading(), 500 );

		}

	};

	const handleModelChange = async ( value ) => {

		const modelIndex = parseInt( value );
		setModel( modelIndex );
		if ( ! window.pathTracerApp ) return;

		setLoading( { isLoading: true, title: "Loading", status: "Loading Model..." } );

		try {

			await window.pathTracerApp.loadExampleModels( modelIndex );
			toast( {
				title: "Model Loaded Successfully",
				description: MODEL_FILES[ modelIndex ].name,
			} );

		} catch ( error ) {

			toast( {
				title: "Error Loading Model",
				description: `${MODEL_FILES[ modelIndex ].name}: ${error.message}`,
				variant: "destructive",
			} );

		} finally {

			window.pathTracerApp.reset();
			setLoading( { isLoading: true, title: "Loading", status: "Model Loaded...", progress: 100 } );
			setTimeout( () => useStore.getState().resetLoading(), 500 );

		}

	};

	const handleDebugModelChange = async ( value ) => {

		const modelIndex = parseInt( value );
		setDebugModel( modelIndex );
		if ( ! window.pathTracerApp ) return;

		setLoading( { isLoading: true, title: "Loading", status: "Loading Debug Model...", progress: 0 } );

		try {

			await window.pathTracerApp.loadModel( DEBUG_MODELS[ modelIndex ].url );
			toast( {
				title: "Model Loaded Successfully",
				description: DEBUG_MODELS[ modelIndex ].name,
			} );

		} catch ( error ) {

			toast( {
				title: "Error Loading Model",
				description: error.message,
				variant: "destructive",
			} );

		} finally {

			window.pathTracerApp.reset();
			setLoading( { isLoading: true, title: "Loading", status: "Loading Debug Model...", progress: 100 } );
			setTimeout( () => useStore.getState().resetLoading(), 500 );

		}

	};

	function applyMaterialInfo( materialInfo, mat ) {

		if ( ! mat ) return console.error( "Invalid material object provided" );

		// Helper function to safely set property if it exists
		const setIfExists = ( obj, prop, value ) => prop in obj && ( obj[ prop ] = value );

		// Reset basic properties
		mat.color?.set?.( 0xffffff );
		mat.attenuationColor?.set?.( 0xffffff );
		mat.specularColor?.set?.( 0xffffff );

		// Set material properties if they exist
		setIfExists( mat, 'transmission', materialInfo.transmission ?? 0.0 );
		setIfExists( mat, 'attenuationDistance', Infinity );
		setIfExists( mat, 'metalness', materialInfo.metalness ?? 0.0 );
		setIfExists( mat, 'roughness', materialInfo.roughness ?? 1.0 );
		setIfExists( mat, 'ior', materialInfo.ior ?? 1.5 );
		setIfExists( mat, 'thickness', 1.0 );

		// Apply specialized properties
		materialInfo.specularColor && mat.specularColor?.setRGB?.( ...materialInfo.specularColor );

		// Handle thin film iridescence
		if ( 'thinFilmThickness' in materialInfo ) {

			setIfExists( mat, 'iridescence', 1.0 );
			setIfExists( mat, 'iridescenceIOR', materialInfo.thinFilmIor || 1.5 );
			setIfExists( mat, 'iridescenceThicknessRange', [ materialInfo.thinFilmThickness, materialInfo.thinFilmThickness ] );

		} else {

			setIfExists( mat, 'iridescence', 0.0 );
			setIfExists( mat, 'iridescenceIOR', 1.0 );
			setIfExists( mat, 'iridescenceThicknessRange', [ 100, 400 ] );

		}

		// Handle transmission vs. diffuse materials
		if ( mat.transmission > 0 ) {

			materialInfo.color && mat.attenuationColor?.setRGB?.( ...materialInfo.color );
			materialInfo.density && setIfExists( mat, 'attenuationDistance', 1000 / materialInfo.density );

		} else {

			materialInfo.color && mat.color?.setRGB?.( ...materialInfo.color );

		}

		setIfExists( mat, 'needsUpdate', true );

	}

	const handleMaterialChange = ( value ) => {

		if ( ! selectedObject ) {

			toast( {
				title: "No Object Selected",
				description: "Please select an object to apply material to",
				variant: "destructive",
			} );
			return;

		}

		if ( ! selectedObject.material ) {

			toast( {
				title: "Invalid Object",
				description: "The selected object doesn't have a material property",
				variant: "destructive",
			} );
			return;

		}

		const materialIndex = parseInt( value );

		// Track the selected material for highlighting
		setSelectedMaterial( materialIndex );

		setLoading( {
			isLoading: true,
			title: "Apply",
			status: "Processing Material...",
			progress: 0
		} );

		try {

			// Output debug info
			console.log( 'Applying material:', {
				materialIndex,
				materialData: materials[ materialIndex ],
				targetObject: selectedObject,
				targetMaterial: selectedObject.material
			} );

			// Apply material properties to the Three.js material
			applyMaterialInfo( materials[ materialIndex ], selectedObject.material );

			// Check if the material index exists
			if ( selectedObject.userData?.materialIndex === undefined ) {

				console.warn( 'Material index not found on selected object, using default index 0' );

			}

			const objMaterialIndex = selectedObject.userData?.materialIndex ?? 0;

			// Update the material in the path tracer
			if ( window.pathTracerApp?.pathTracingPass?.updateMaterial ) {

				// New API - preferred method with better organization
				window.pathTracerApp.pathTracingPass.updateMaterial(
					objMaterialIndex,
					selectedObject.material
				);

			} else if ( window.pathTracerApp?.pathTracingPass?.rebuildMaterialDataTexture ) {

				// Legacy API - fallback for compatibility
				window.pathTracerApp.pathTracingPass.rebuildMaterialDataTexture(
					objMaterialIndex,
					selectedObject.material
				);

			} else {

				console.warn( 'PathTracer material update function not found' );

			}

			// Reset renderer to apply changes
			if ( window.pathTracerApp?.reset ) {

				window.pathTracerApp.reset();

			}

			toast( {
				title: "Material Applied",
				description: materials[ materialIndex ]?.name || `Material #${materialIndex}`,
			} );

		} catch ( error ) {

			console.error( "Error applying material:", error );
			toast( {
				title: "Error Applying Material",
				description: error.message || "Unknown error occurred",
				variant: "destructive",
			} );

		} finally {

			useStore.getState().resetLoading();

		}

	};

	// Helper function to get safe string values for ItemsCatalog
	const getModelValue = () => {

		return model !== null && model !== undefined ? model.toString() : null;

	};

	const getMaterialValue = () => {

		return selectedMaterial !== null && selectedMaterial !== undefined ? selectedMaterial.toString() : null;

	};

	const getDebugModelValue = () => {

		return debugModel !== null && debugModel !== undefined ? debugModel.toString() : null;

	};

	return (
		<div className="absolute h-[calc(100%-48px)] w-full">
			<Separator className="bg-primary" />
			<Tabs
				value={activeTab}
				onValueChange={setActiveTab}
				className="flex flex-col h-full w-full"
			>
				<TabsList className="relative grid w-full grid-cols-4 h-auto p-0">
					<TabsTrigger value="models" className="text-xs truncate py-2">
                        Models
					</TabsTrigger>
					<TabsTrigger value="materials" className="text-xs truncate py-2">
                        Materials
					</TabsTrigger>
					<TabsTrigger value="environments" className="text-xs truncate py-2">
                        Env
					</TabsTrigger>
					<TabsTrigger value="tests" className="text-xs truncate py-2">
                        Tests
					</TabsTrigger>
				</TabsList>
				<TabsContent value="models" className="relative h-full data-[state=inactive]:hidden data-[state=active]:flex flex-col">
					<ItemsCatalog
						data={MODEL_FILES}
						value={getModelValue()}
						onValueChange={handleModelChange}
					/>
				</TabsContent>
				<TabsContent value="materials" className="relative h-full data-[state=inactive]:hidden data-[state=active]:flex flex-col">
					<ItemsCatalog
						data={materials}
						value={getMaterialValue()}
						onValueChange={handleMaterialChange}
					/>
				</TabsContent>
				<TabsContent value="environments" className="relative h-full data-[state=inactive]:hidden data-[state=active]:flex flex-col">
					<EnvironmentCatalog
						value={getEnvironmentIndex()}
						onValueChange={handleEnvironmentChange}
					/>
				</TabsContent>
				<TabsContent value="tests" className="relative h-full data-[state=inactive]:hidden data-[state=active]:flex flex-col">
					<ItemsCatalog
						data={DEBUG_MODELS}
						value={getDebugModelValue()}
						onValueChange={handleDebugModelChange}
					/>
				</TabsContent>
			</Tabs>
		</div>
	);

};

export default AssetsTab;
