import { RpcProvider, Account, Contract, shortString, CallData, constants } from 'starknet';
import fs from 'fs';
import dotenv from 'dotenv';

// Charger les variables d'environnement
dotenv.config();

/**
 * Type for a Starknet contract address (hex string starting with 0x)
 */
type ContractAddress = string;

/**
 * Type for a Starknet account address (hex string starting with 0x)
 */
type AccountAddress = string;

/**
 * Main class to interact with the StarkWolf game contract
 */
export class StarkWolfGame {
    private contract: Contract;
    private provider: RpcProvider;
    private accounts: Map<string, Account>;

    /**
     * Creates a new instance of the StarkWolfGame
     * @param contractAddress - The address of the deployed game contract
     * @param nodeUrl - The URL of the Starknet node (defaults to local devnet)
     */
    constructor(
        contractAddress: ContractAddress,
        nodeUrl: string = 'https://api.cartridge.gg/x/starknet/sepolia',
    ) {
        this.provider = new RpcProvider({ nodeUrl });
        this.accounts = new Map();
        
        // Load ABI from JSON file
        const abiPath = './abi_actions.json';
        const abiData = fs.readFileSync(abiPath, 'utf-8');
        const abi = JSON.parse(abiData).abi;
        this.contract = new Contract(abi, contractAddress, this.provider);
    }

    addAccount(address: string, privateKey: string) {
        this.accounts.set(address, new Account(this.provider, address, privateKey));
    }

    /**
     * Helper function to retry failed transactions
     */
    private async retryTransaction<T>(
        operation: () => Promise<T>,
        maxAttempts: number = 5,
        delayMs: number = 2000
    ): Promise<T> {
        let lastError;
        for (let attempt = 1; attempt <= maxAttempts; attempt++) {
            try {
                return await operation();
            } catch (error) {
                lastError = error;
                if (attempt < maxAttempts) {
                    console.log(`Attempt ${attempt} failed, retrying in ${delayMs}ms...`);
                    await new Promise(resolve => setTimeout(resolve, delayMs));
                } else if (maxAttempts > 1) {
                    // Ne pas afficher ce message si maxAttempts est 1 (cas spécial pour werewolfAction)
                    console.log(`All ${maxAttempts} attempts failed.`);
                }
            }
        }
        throw lastError;
    }

    /**
     * Starts a new game with the specified players
     * @param gameId - Unique identifier for the game
     * @param players - Array of player account addresses to participate in the game
     * @param starterAddress - Account address of the player starting the game
     * @returns Transaction receipt
     */
    async startGame(gameId: number, players: AccountAddress[], starterAddress: string) {
        try {
            const starterAccount = this.accounts.get(starterAddress);
            if (!starterAccount) throw new Error('Starter account not found');
            
            this.contract.connect(starterAccount);

            // Vérifier si une partie existe déjà avec cet ID
            try {
                const gameState = await this.contract.get_game_state(gameId);
                console.log('Existing game state:', gameState);
                throw new Error('Game already exists with this ID');
            } catch (error) {
                // Si nous avons une erreur ici, c'est probablement parce que le jeu n'existe pas encore
                // ce qui est ce que nous voulons
                console.log('No existing game found, creating new game...');
            }

            const calldata = CallData.compile({
                game_id: gameId,
                players: players
            });

            return await this.retryTransaction(async () => {
                // Forcer l'utilisation de la version V3 pour cette transaction
                console.log('Using transaction version:', constants.TRANSACTION_VERSION.V3);
                const tx = await starterAccount.execute(
                    {
                        contractAddress: this.contract.address,
                        entrypoint: 'start_game',
                        calldata: calldata
                    },
                    undefined,
                    { version: constants.TRANSACTION_VERSION.V3 }
                );
                await this.provider.waitForTransaction(tx.transaction_hash);
                return tx;
            });
        } catch (error) {
            console.error('Error starting game:', error);
            throw error;
        }
    }

    /**
     * Casts a vote against a target player
     * @param gameId - Identifier of the active game
     * @param target - Account address of the player being voted against
     * @param voterAddress - Account address of the voter
     * @returns Transaction receipt
     */
    async vote(gameId: number, target: AccountAddress, voterAddress: string) {
        try {
            const voterAccount = this.accounts.get(voterAddress);
            if (!voterAccount) throw new Error('Voter account not found');
            
            this.contract.connect(voterAccount);
            const calldata = CallData.compile({
                game_id: gameId,
                target: target
            });
            
            return await this.retryTransaction(async () => {
                console.log('Sending vote transaction...');
                // Forcer l'utilisation de la version V3 pour cette transaction
                const tx = await voterAccount.execute(
                    {
                        contractAddress: this.contract.address,
                        entrypoint: 'vote',
                        calldata: calldata
                    },
                    undefined,
                    { version: constants.TRANSACTION_VERSION.V3 }
                );
                console.log('Transaction sent, waiting for confirmation...');
                await this.provider.waitForTransaction(tx.transaction_hash);
                console.log('Vote confirmed');
                return tx;
            });
        } catch (error) {
            console.error('Error voting:', error);
            throw error;
        }
    }

    /**
     * Executes a kill action against a target player (for werewolves)
     * @param gameId - Identifier of the active game
     * @param target - Account address of the player to kill
     * @param killerAddress - Account address of the werewolf
     * @returns Transaction receipt
     */
    async werewolfAction(gameId: number, target: AccountAddress, killerAddress: string) {
        try {
            const killerAccount = this.accounts.get(killerAddress);
            if (!killerAccount) throw new Error('Killer account not found');
            
            this.contract.connect(killerAccount);
            const calldata = CallData.compile({
                game_id: gameId,
                target: target
            });

            return await this.retryTransaction(async () => {
                console.log('Sending night action transaction...');
                // Forcer l'utilisation de la version V3 pour cette transaction
                try {
                    const tx = await killerAccount.execute(
                        {
                            contractAddress: this.contract.address,
                            entrypoint: 'night_action',
                            calldata: calldata
                        },
                        undefined,
                        { version: constants.TRANSACTION_VERSION.V3 }
                    );
                    console.log('Transaction sent, waiting for confirmation...');
                    await this.provider.waitForTransaction(tx.transaction_hash);
                    console.log('Night action confirmed');
                    return tx;
                } catch (error: any) {
                    // Vérifier si l'erreur est "Target protected"
                    if (error.message && error.message.includes('Target protected')) {
                        console.log('🛡️ Target is protected by the guard! Attack failed but game continues.');
                        // Retourner un objet factice pour indiquer que l'action a été traitée
                        return { transaction_hash: 'protected_target_handled' };
                    }
                    // Si c'est une autre erreur, la relancer
                    throw error;
                }
            }, 1); // Réduire à 1 tentative car nous gérons déjà le cas "Target protected"
        } catch (error) {
            // Vérifier à nouveau si l'erreur est "Target protected" (au cas où elle n'aurait pas été attrapée dans retryTransaction)
            if (error instanceof Error && error.message && error.message.includes('Target protected')) {
                console.log('🛡️ Target is protected by the guard! Attack failed but game continues.');
                // Retourner un objet factice pour indiquer que l'action a été traitée
                return { transaction_hash: 'protected_target_handled' };
            }
            
            console.error('Error performing night action:', error);
            throw error;
        }
    }

    /**
     * Pairs two players as lovers using Cupid's ability
     * @param gameId - Identifier of the active game
     * @param lover1 - Account address of the first player to pair
     * @param lover2 - Account address of the second player to pair
     * @param cupidAddress - Account address of the Cupid
     * @returns Transaction receipt
     */
    async cupidAction(gameId: number, lover1: AccountAddress, lover2: AccountAddress, cupidAddress: string) {
        try {
            const cupidAccount = this.accounts.get(cupidAddress);
            if (!cupidAccount) throw new Error('Cupid account not found');
            
            this.contract.connect(cupidAccount);
            const calldata = CallData.compile({
                game_id: gameId,
                lover1: lover1,
                lover2: lover2
            });

            return await this.retryTransaction(async () => {
                // Forcer l'utilisation de la version V3 pour cette transaction
                const tx = await cupidAccount.execute(
                    {
                        contractAddress: this.contract.address,
                        entrypoint: 'cupid_action',
                        calldata: calldata
                    },
                    undefined,
                    { version: constants.TRANSACTION_VERSION.V3 }
                );
                await this.provider.waitForTransaction(tx.transaction_hash);
                console.log('Lovers paired successfully');
                return tx;
            });
        } catch (error) {
            console.error('Error pairing lovers:', error);
            throw error;
        }
    }

    /**
     * Ends the voting phase
     * @param gameId - Identifier of the active game
     * @returns Transaction receipt
     */
    async endVoting(gameId: number) {
        try {
            // Utiliser le premier compte disponible pour cette opération
            const firstAccount = this.accounts.values().next().value;
            if (!firstAccount) throw new Error('No accounts available');
            
            this.contract.connect(firstAccount);
            const calldata = CallData.compile({
                game_id: gameId
            });
            
            // Forcer l'utilisation de la version V3 pour cette transaction
            const tx = await firstAccount.execute(
                {
                    contractAddress: this.contract.address,
                    entrypoint: 'end_voting',
                    calldata: calldata
                },
                undefined,
                { version: constants.TRANSACTION_VERSION.V3 }
            );
            await this.provider.waitForTransaction(tx.transaction_hash);
            console.log('Voting phase ended');
            return tx;
        } catch (error) {
            console.error('Error ending voting phase:', error);
            throw error;
        }
    }

    /**
     * Transitions the game from night phase to day phase
     * @param gameId - Identifier of the active game
     * @param callerAddress - Account address of the player calling this function
     * @returns Transaction receipt
     */
    async passNight(gameId: number, callerAddress?: string) {
        try {
            // Use the specified caller or the first available account
            const account = callerAddress 
                ? this.accounts.get(callerAddress) 
                : this.accounts.values().next().value;
                
            if (!account) throw new Error('No account available for this operation');
            
            this.contract.connect(account);
            const calldata = CallData.compile({
                game_id: gameId
            });
            
            return await this.retryTransaction(async () => {
                console.log('Transitioning from night to day phase...');
                // Force using transaction version V3
                const tx = await account.execute(
                    {
                        contractAddress: this.contract.address,
                        entrypoint: 'pass_night',
                        calldata: calldata
                    },
                    undefined,
                    { version: constants.TRANSACTION_VERSION.V3 }
                );
                console.log('Transaction sent, waiting for confirmation...');
                await this.provider.waitForTransaction(tx.transaction_hash);
                console.log('Night phase ended, day phase started');
                return tx;
            });
        } catch (error) {
            console.error('Error transitioning to day phase:', error);
            throw error;
        }
    }

    /**
     * Transitions the game from day phase to night phase
     * @param gameId - Identifier of the active game
     * @param callerAddress - Account address of the player calling this function
     * @returns Transaction receipt
     */
    async passDay(gameId: number, callerAddress?: string) {
        try {
            // Use the specified caller or the first available account
            const account = callerAddress 
                ? this.accounts.get(callerAddress) 
                : this.accounts.values().next().value;
                
            if (!account) throw new Error('No account available for this operation');
            
            this.contract.connect(account);
            const calldata = CallData.compile({
                game_id: gameId
            });
            
            return await this.retryTransaction(async () => {
                console.log('Transitioning from day to night phase...');
                // Force using transaction version V3
                const tx = await account.execute(
                    {
                        contractAddress: this.contract.address,
                        entrypoint: 'pass_day',
                        calldata: calldata
                    },
                    undefined,
                    { version: constants.TRANSACTION_VERSION.V3 }
                );
                console.log('Transaction sent, waiting for confirmation...');
                await this.provider.waitForTransaction(tx.transaction_hash);
                console.log('Day phase ended, night phase started');
                return tx;
            });
        } catch (error) {
            console.error('Error transitioning to night phase:', error);
            throw error;
        }
    }

    /**
     * Executes the witch's ability to save or poison a player
     * @param gameId - Identifier of the active game
     * @param target - Account address of the player to save or poison
     * @param save - Whether to use the save potion
     * @param poison - Whether to use the poison potion
     * @param witchAddress - Account address of the witch
     * @returns Transaction receipt
     */
    async witchAction(gameId: number, target: AccountAddress, save: boolean, poison: boolean, witchAddress: string) {
        try {
            const witchAccount = this.accounts.get(witchAddress);
            if (!witchAccount) throw new Error('Witch account not found');
            
            this.contract.connect(witchAccount);
            const calldata = CallData.compile({
                game_id: gameId,
                target: target,
                save: save ? 1 : 0,
                poison: poison ? 1 : 0
            });

            return await this.retryTransaction(async () => {
                console.log('Witch casting spell...');
                // Forcer l'utilisation de la version V3 pour cette transaction
                const tx = await witchAccount.execute(
                    {
                        contractAddress: this.contract.address,
                        entrypoint: 'witch_action',
                        calldata: calldata
                    },
                    undefined,
                    { version: constants.TRANSACTION_VERSION.V3 }
                );
                console.log('Transaction sent, waiting for confirmation...');
                await this.provider.waitForTransaction(tx.transaction_hash);
                console.log('Witch spell confirmed');
                return tx;
            });
        } catch (error) {
            console.error('Error performing witch action:', error);
            throw error;
        }
    }

    /**
     * Executes the hunter's revenge shot after being killed
     * @param gameId - Identifier of the active game
     * @param target - Account address of the player to shoot
     * @param hunterAddress - Account address of the dead hunter
     * @returns Transaction receipt
     */
    async hunterAction(gameId: number, target: AccountAddress, hunterAddress: string) {
        try {
            const hunterAccount = this.accounts.get(hunterAddress);
            if (!hunterAccount) throw new Error('Hunter account not found');
            
            this.contract.connect(hunterAccount);
            const calldata = CallData.compile({
                game_id: gameId,
                target: target
            });

            return await this.retryTransaction(async () => {
                console.log('Hunter attempting revenge shot...');
                // Forcer l'utilisation de la version V3 pour cette transaction
                const tx = await hunterAccount.execute(
                    {
                        contractAddress: this.contract.address,
                        entrypoint: 'hunter_action',
                        calldata: calldata
                    },
                    undefined,
                    { version: constants.TRANSACTION_VERSION.V3 }
                );
                console.log('Transaction sent, waiting for confirmation...');
                await this.provider.waitForTransaction(tx.transaction_hash);
                console.log('Hunter shot confirmed');
                return tx;
            });
        } catch (error) {
            console.error('Error performing hunter action:', error);
            throw error;
        }
    }

}

// Example usage
async function main() {
    try {
        const contractAddress = '0x02f5c289133869e42ddf01b1c6dbf6b17d06f19ebf2105b118ac892cb3a1b8c9';
        console.log('Contract address:', contractAddress);

        const game = new StarkWolfGame(contractAddress);

        // Setup accounts and roles
        const accounts = Array.from({length: 8}, (_, i) => {
            const address = process.env[`PLAYER${i}_ADDRESS`];
            const privateKey = process.env[`PLAYER${i}_PRIVATE_KEY`];
            
            if (!address || !privateKey) {
                throw new Error(`Missing environment variables for player ${i}`);
            }
            return { address: address as string, privateKey: privateKey as string };
        });

        accounts.forEach(account => game.addAccount(account.address, account.privateKey));
        const players = accounts.map(account => account.address);

        const roles = {
            werewolf: players[0],
            witch: players[1],
            guard: players[2],
            seer: players[3],
            hunter: players[4],
            cupid: players[5],
            villager1: players[6],
            villager2: players[7]
        };

        // Utiliser un ID de jeu basé sur un timestamp pour éviter les collisions
        //const gameId = Math.floor(Date.now() / 1000000000);
        const gameId = Math.floor(Math.random() * 10000);

        console.log('Starting game with ID:', gameId);

        // Délai entre les actions (ms) - augmenté pour assurer le traitement des transactions
        const SHORT_DELAY = 1000;
        // Délai entre les phases (ms) - augmenté pour assurer le traitement des transactions
        const PHASE_DELAY = 2000;

        try {
            // Démarrer le jeu
            console.log("Starting game...");
            try {
                await game.startGame(gameId, players, roles.werewolf);
                console.log("Game started successfully with ID:", gameId);
            } catch (error: any) {
                // Vérifier si l'erreur est "Game started"
                if (error.message && error.message.includes('Game started')) {
                    console.log("A game with this ID already exists. Continuing with existing game...");
                } else {
                    // Si c'est une autre erreur, la relancer
                    throw error;
                }
            }
            
            // Actions de la première nuit
            console.log("First night actions...");
            
            // Action du Cupidon - pair villager1 and seer as lovers
            console.log("Cupid pairing lovers...");
            await game.cupidAction(gameId, roles.villager1, roles.seer, roles.cupid);
            await new Promise(resolve => setTimeout(resolve, SHORT_DELAY));
            
            // Action du Garde - protect seer
            console.log("Guard protecting seer...");
            await game.werewolfAction(gameId, roles.seer, roles.guard);
            await new Promise(resolve => setTimeout(resolve, SHORT_DELAY));
            
            // Passer au jour
            console.log("Transitioning to day phase...");
            await game.passNight(gameId);
            await new Promise(resolve => setTimeout(resolve, PHASE_DELAY));
            
            // Votes du premier jour
            console.log("Day voting phase...");
            await game.vote(gameId, roles.hunter, roles.werewolf);
            await new Promise(resolve => setTimeout(resolve, SHORT_DELAY));
            await game.vote(gameId, roles.hunter, roles.witch);
            await new Promise(resolve => setTimeout(resolve, SHORT_DELAY));
            await game.vote(gameId, roles.hunter, roles.guard);
            await new Promise(resolve => setTimeout(resolve, SHORT_DELAY));
            await game.vote(gameId, roles.werewolf, roles.cupid);
            await new Promise(resolve => setTimeout(resolve, SHORT_DELAY));
            
            // Terminer le vote
            console.log("Ending voting phase...");
            await game.endVoting(gameId);
            await new Promise(resolve => setTimeout(resolve, PHASE_DELAY));
            
            // Action du chasseur après élimination
            console.log("Hunter's revenge shot...");
            await game.hunterAction(gameId, roles.cupid, roles.hunter);
            await new Promise(resolve => setTimeout(resolve, PHASE_DELAY));
            
            // Passer à la nuit
            console.log("Transitioning to night phase...");
            await game.passDay(gameId);
            await new Promise(resolve => setTimeout(resolve, PHASE_DELAY));
            
            // Actions de la deuxième nuit
            console.log("Second night actions...");
            
            // Action du Garde - protect witch
            console.log("Guard protecting witch...");
            await game.werewolfAction(gameId, roles.witch, roles.guard);
            await new Promise(resolve => setTimeout(resolve, SHORT_DELAY));
            
            // Action du Loup-garou - kill villager2
            console.log("Werewolf killing villager2...");
            await game.werewolfAction(gameId, roles.villager2, roles.werewolf);
            await new Promise(resolve => setTimeout(resolve, SHORT_DELAY));
            
            // Action de la Sorcière - save villager2
            console.log("Witch saving villager2...");
            await game.witchAction(gameId, roles.villager2, true, false, roles.witch);
            await new Promise(resolve => setTimeout(resolve, SHORT_DELAY));
            
            // Passer au jour
            console.log("Transitioning to day phase...");
            await game.passNight(gameId);
            await new Promise(resolve => setTimeout(resolve, PHASE_DELAY));
            
            // Votes du deuxième jour
            console.log("Second day voting phase...");
            await game.vote(gameId, roles.guard, roles.werewolf);
            await new Promise(resolve => setTimeout(resolve, SHORT_DELAY));
            await game.vote(gameId, roles.guard, roles.witch);
            await new Promise(resolve => setTimeout(resolve, SHORT_DELAY));
            await game.vote(gameId, roles.villager1, roles.guard);
            await new Promise(resolve => setTimeout(resolve, SHORT_DELAY));
            await game.vote(gameId, roles.guard, roles.villager1);
            await new Promise(resolve => setTimeout(resolve, SHORT_DELAY));
            
            // Terminer le vote
            console.log("Ending voting phase...");
            await game.endVoting(gameId);
            await new Promise(resolve => setTimeout(resolve, PHASE_DELAY));
            
            // Passer à la nuit
            console.log("Transitioning to night phase...");
            await game.passDay(gameId);
            await new Promise(resolve => setTimeout(resolve, PHASE_DELAY));
            
            // Actions de la troisième nuit
            console.log("Third night actions...");
            
            // Action du Loup-garou - kill villager2
            console.log("Werewolf killing villager2...");
            await game.werewolfAction(gameId, roles.villager2, roles.werewolf);
            await new Promise(resolve => setTimeout(resolve, SHORT_DELAY));
            
            // Passer au jour
            console.log("Transitioning to day phase...");
            await game.passNight(gameId);
            await new Promise(resolve => setTimeout(resolve, PHASE_DELAY));
            
            // Votes du troisième jour
            console.log("Third day voting phase...");
            await game.vote(gameId, roles.witch, roles.werewolf);
            await new Promise(resolve => setTimeout(resolve, SHORT_DELAY));
            await game.vote(gameId, roles.werewolf, roles.witch);
            await new Promise(resolve => setTimeout(resolve, SHORT_DELAY));
            await game.vote(gameId, roles.witch, roles.villager1);
            await new Promise(resolve => setTimeout(resolve, SHORT_DELAY));
            
            // Terminer le vote
            console.log("Ending voting phase...");
            await game.endVoting(gameId);
            await new Promise(resolve => setTimeout(resolve, PHASE_DELAY));
            
            // Passer à la nuit
            console.log("Transitioning to night phase...");
            await game.passDay(gameId);
            await new Promise(resolve => setTimeout(resolve, PHASE_DELAY));
            
            // Actions de la quatrième nuit
            console.log("Fourth night actions...");
            
            // Action du Loup-garou - kill villager1
            console.log("Werewolf killing villager1...");
            await game.werewolfAction(gameId, roles.villager1, roles.werewolf);
            await new Promise(resolve => setTimeout(resolve, SHORT_DELAY));
            
            // Passer au jour
            console.log("Transitioning to day phase...");
            await game.passNight(gameId);
            await new Promise(resolve => setTimeout(resolve, PHASE_DELAY));
            
            console.log("Game completed - werewolves win!");
            console.log("Only the werewolf remains alive.");
            
            // Add a return statement to stop execution here
            return;
            
        } catch (error) {
            console.error("An error occurred during game execution:", error);
        }
    } catch (error) {
        console.error("Failed to initialize game:", error);
    }
}

main();
