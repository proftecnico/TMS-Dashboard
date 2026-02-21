(function() {
    const encodedConfig = {
        a: "QUl6YVN5RFZldWhKdDNqZGxrR2NMcjBudnVKQTRxWmxkWnAweFh3",
        b: "Z2VzdGlvbmZsb3RhLWVhNDYxLmZpcmViYXNlYXBwLmNvbQ==",
        c: "aHR0cHM6Ly9nZXN0aW9uZmxvdGEtZWE0NjEtZGVmYXVsdC1ydGRiLmZpcmViYXNlaW8uY29t",
        d: "Z2VzdGlvbmZsb3RhLWVhNDYx",
        e: "Z2VzdGlvbmZsb3RhLWVhNDYxLmZpcmViYXNlc3RvcmFnZS5hcHA=",
        f: "NDM1Mjg2MzYyODg=",
        g: "MTo0MzUyODYzNjI4ODp3ZWI6YzhhOWYzZjc0MGJjZmI3ZTg1NjM2NQ=="
    };

    window.firebaseConfig = {
        apiKey: atob(encodedConfig.a),
        authDomain: atob(encodedConfig.b),
        databaseURL: atob(encodedConfig.c),
        projectId: atob(encodedConfig.d),
        storageBucket: atob(encodedConfig.e),
        messagingSenderId: atob(encodedConfig.f),
        appId: atob(encodedConfig.g)
    };
})();
