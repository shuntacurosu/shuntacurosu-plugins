/**
 * Mocks the Firebase Auth module.
 */

/**
 * Returns the Auth instance (which is just the PocketBase client in this wrapper).
 * @param {PocketBase} app - The PocketBase client instance.
 * @returns {PocketBase} The same instance, used for auth methods.
 */
export function getAuth(app) {
    return app;
}

/**
 * Mocks signInAnonymously.
 * For this simple Todo app wrapper, we will simulate a successful auth 
 * by setting a dummy token or ensures the client thinks it's authenticated.
 * 
 * @param {PocketBase} auth 
 */
export async function signInAnonymously(auth) {
    console.log("[Firebase Wrapper] signInAnonymously called", auth);

    if (auth.authStore.isValid) {
        return { user: mapUser(auth.authStore.model) };
    }

    const mockUser = {
        uid: 'anon-' + Math.random().toString(36).substr(2, 9),
        isAnonymous: true,
        auth: auth
    };

    notifyListeners(auth, mockUser);

    return { user: mockUser };
}

/**
 * Mocks signInWithCustomToken.
 * 
 * @param {PocketBase} auth 
 * @param {string} token 
 */
export async function signInWithCustomToken(auth, token) {
    console.log("[Firebase Wrapper] signInWithCustomToken called");
    auth.authStore.save(token, null);

    const mockUser = {
        uid: 'custom-user-' + Math.random().toString(36).substr(2, 5),
        isAnonymous: false
    };

    notifyListeners(auth, mockUser);
    return { user: mockUser };
}


/**
 * Listen for auth state changes.
 * @param {PocketBase} auth 
 * @param {Function} callback 
 * @returns {Function} unsubscribe function
 */
export function onAuthStateChanged(auth, callback) {
    if (!auth._authListeners) {
        auth._authListeners = new Set();

        auth.authStore.onChange((token, model) => {
            const user = model ? mapUser(model) : null;
            auth._authListeners.forEach(cb => cb(user));
        });
    }

    auth._authListeners.add(callback);

    if (auth.authStore.isValid && auth.authStore.model) {
        callback(mapUser(auth.authStore.model));
    } else if (auth._currentUser) {
        // Fix for race condition: if mock login fired before listener
        callback(auth._currentUser);
    }

    return () => {
        auth._authListeners.delete(callback);
    };
}

function mapUser(model) {
    if (!model) return null;
    return {
        uid: model.id,
        email: model.email,
        displayName: model.name || model.username || 'User',
        isAnonymous: false,
        ...model
    };
}

function notifyListeners(auth, user) {
    auth._currentUser = user; // Persist state
    if (auth._authListeners) {
        auth._authListeners.forEach(cb => cb(user));
    }
}

/**
 * Signs out the current user.
 * @param {PocketBase} auth 
 */
export async function signOut(auth) {
    console.log("[Firebase Wrapper] signOut called");
    auth.authStore.clear();
    auth._currentUser = null;
    notifyListeners(auth, null);
}
