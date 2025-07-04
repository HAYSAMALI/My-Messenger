import React, { useState, useEffect, useRef } from 'react';
import './App.css';

const BACKEND_URL = process.env.REACT_APP_BACKEND_URL;
const API = `${BACKEND_URL}/api`;

// Encryption utilities using Web Crypto API
class EncryptionManager {
  constructor() {
    this.key = null;
  }

  // Generate a shared key for Alpha-Bravo conversation using a simple approach
  async generateSharedKey() {
    // Use a simple shared secret that both Alpha and Bravo will use
    // In production, this would be done through secure key exchange
    const sharedKeyData = new Uint8Array([
      0x01, 0x23, 0x45, 0x67, 0x89, 0xAB, 0xCD, 0xEF,
      0xFE, 0xDC, 0xBA, 0x98, 0x76, 0x54, 0x32, 0x10,
      0x0F, 0x1E, 0x2D, 0x3C, 0x4B, 0x5A, 0x69, 0x78,
      0x87, 0x96, 0xA5, 0xB4, 0xC3, 0xD2, 0xE1, 0xF0
    ]);

    this.key = await window.crypto.subtle.importKey(
      'raw',
      sharedKeyData,
      {
        name: 'AES-GCM',
        length: 256,
      },
      true,
      ['encrypt', 'decrypt']
    );
    
    return this.key;
  }

  // Export key to share with other user (in a real app, this would be done securely)
  async exportKey() {
    if (!this.key) return null;
    const exported = await window.crypto.subtle.exportKey('raw', this.key);
    return Array.from(new Uint8Array(exported));
  }

  // Import key from array
  async importKey(keyArray) {
    const keyData = new Uint8Array(keyArray);
    this.key = await window.crypto.subtle.importKey(
      'raw',
      keyData,
      {
        name: 'AES-GCM',
        length: 256,
      },
      true,
      ['encrypt', 'decrypt']
    );
  }

  // Encrypt message
  async encrypt(message) {
    if (!this.key) {
      await this.generateSharedKey();
    }

    const encoder = new TextEncoder();
    const data = encoder.encode(message);
    const iv = window.crypto.getRandomValues(new Uint8Array(12));

    const encrypted = await window.crypto.subtle.encrypt(
      {
        name: 'AES-GCM',
        iv: iv,
      },
      this.key,
      data
    );

    // Combine IV and encrypted data
    const combined = new Uint8Array(iv.length + encrypted.byteLength);
    combined.set(iv);
    combined.set(new Uint8Array(encrypted), iv.length);

    return btoa(String.fromCharCode(...combined));
  }

  // Decrypt message
  async decrypt(encryptedMessage) {
    if (!this.key) {
      await this.generateSharedKey();
    }

    try {
      const combined = new Uint8Array(
        atob(encryptedMessage)
          .split('')
          .map(char => char.charCodeAt(0))
      );

      const iv = combined.slice(0, 12);
      const data = combined.slice(12);

      const decrypted = await window.crypto.subtle.decrypt(
        {
          name: 'AES-GCM',
          iv: iv,
        },
        this.key,
        data
      );

      const decoder = new TextDecoder();
      return decoder.decode(decrypted);
    } catch (error) {
      console.error('Decryption failed:', error);
      return '[Decryption Error]';
    }
  }
}

function App() {
  const [user, setUser] = useState(null);
  const [password, setPassword] = useState('');
  const [messages, setMessages] = useState([]);
  const [newMessage, setNewMessage] = useState('');
  const [wsConnected, setWsConnected] = useState(false);
  const [loginError, setLoginError] = useState('');
  const [isDarkTheme, setIsDarkTheme] = useState(() => {
    // Load theme preference from localStorage or default to light
    const savedTheme = localStorage.getItem('theme');
    return savedTheme === 'dark';
  });
  
  const encryptionManager = useRef(new EncryptionManager());
  const ws = useRef(null);
  const messagesEndRef = useRef(null);
  const messageRefreshInterval = useRef(null);

  // Scroll to bottom of messages
  const scrollToBottom = () => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  };

  useEffect(() => {
    scrollToBottom();
  }, [messages]);

  // Set up periodic message refresh when user is logged in
  useEffect(() => {
    if (user) {
      // Load messages initially
      loadMessages();
      
      // Set up periodic refresh every 2 seconds
      messageRefreshInterval.current = setInterval(() => {
        loadMessages();
      }, 2000);
    } else {
      // Clear interval when user logs out
      if (messageRefreshInterval.current) {
        clearInterval(messageRefreshInterval.current);
        messageRefreshInterval.current = null;
      }
    }

    // Cleanup on unmount
    return () => {
      if (messageRefreshInterval.current) {
        clearInterval(messageRefreshInterval.current);
      }
    };
  }, [user]);

  // Initialize WebSocket connection
  const initWebSocket = (username) => {
    const wsUrl = `${BACKEND_URL.replace('https://', 'wss://').replace('http://', 'ws://')}/api/ws/${username}`;
    ws.current = new WebSocket(wsUrl);

    ws.current.onopen = () => {
      console.log('WebSocket connected');
      setWsConnected(true);
    };

    ws.current.onmessage = (event) => {
      const data = JSON.parse(event.data);
      if (data.type === 'new_message') {
        // Reload messages when we receive a new message notification
        console.log('Received new message notification, reloading messages');
        setTimeout(() => loadMessages(), 100); // Small delay to ensure message is saved
      }
    };

    ws.current.onclose = () => {
      console.log('WebSocket disconnected');
      setWsConnected(false);
    };

    ws.current.onerror = (error) => {
      console.error('WebSocket error:', error);
      setWsConnected(false);
    };
  };

  // Login function
  const handleLogin = async (e) => {
    e.preventDefault();
    setLoginError('');

    try {
      const response = await fetch(`${API}/login`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ password }),
      });

      const data = await response.json();

      if (data.success) {
        setUser(data.user);
        await encryptionManager.current.generateSharedKey();
        initWebSocket(data.user);
        // loadMessages will be called by the useEffect when user state changes
      } else {
        setLoginError(data.message);
      }
    } catch (error) {
      setLoginError('Connection error. Please try again.');
      console.error('Login error:', error);
    }
  };

  // Load messages
  const loadMessages = async () => {
    if (!user) return;

    try {
      console.log(`Loading messages for ${user}`);
      const response = await fetch(`${API}/messages/${user}`);
      const data = await response.json();

      // Decrypt messages
      const decryptedMessages = await Promise.all(
        data.map(async (msg) => {
          try {
            const decrypted_content = await encryptionManager.current.decrypt(msg.encrypted_content);
            return {
              ...msg,
              decrypted_content
            };
          } catch (error) {
            console.error('Failed to decrypt message:', error);
            return {
              ...msg,
              decrypted_content: '[Decryption Error]'
            };
          }
        })
      );

      console.log(`Loaded ${decryptedMessages.length} messages for ${user}`);
      setMessages(decryptedMessages);
    } catch (error) {
      console.error('Error loading messages:', error);
    }
  };

  // Send message
  const handleSendMessage = async (e) => {
    e.preventDefault();
    if (!newMessage.trim() || !user) return;

    const receiver = user === 'Alpha' ? 'Bravo' : 'Alpha';
    
    try {
      // Encrypt the message
      const encryptedContent = await encryptionManager.current.encrypt(newMessage);

      const response = await fetch(`${API}/messages?sender=${user}`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          receiver,
          encrypted_content: encryptedContent,
        }),
      });

      if (response.ok) {
        setNewMessage('');
        // Reload messages immediately for the sender
        await loadMessages();
      }
    } catch (error) {
      console.error('Error sending message:', error);
    }
  };

  // Toggle theme
  const toggleTheme = () => {
    const newTheme = !isDarkTheme;
    setIsDarkTheme(newTheme);
    localStorage.setItem('theme', newTheme ? 'dark' : 'light');
  };

  // Clear message history
  const handleClearHistory = async () => {
    if (window.confirm('Are you sure you want to clear all message history? This cannot be undone.')) {
      try {
        const response = await fetch(`${API}/messages/clear`, {
          method: 'DELETE',
        });
        
        if (response.ok) {
          const result = await response.json();
          console.log(result.message);
          // Clear local messages and reload
          setMessages([]);
          await loadMessages();
        }
      } catch (error) {
        console.error('Error clearing message history:', error);
        alert('Failed to clear message history. Please try again.');
      }
    }
  };

  // Logout
  const handleLogout = () => {
    setUser(null);
    setMessages([]);
    setPassword('');
    setLoginError('');
    if (ws.current) {
      ws.current.close();
    }
    // Clear message refresh interval
    if (messageRefreshInterval.current) {
      clearInterval(messageRefreshInterval.current);
      messageRefreshInterval.current = null;
    }
  };

  // Login screen
  if (!user) {
    return (
      <div className={`min-h-screen ${isDarkTheme ? 'bg-gradient-to-br from-gray-900 to-black' : 'bg-gradient-to-br from-blue-900 to-purple-900'} flex items-center justify-center px-4`}>
        <div className={`${isDarkTheme ? 'bg-gray-800 border border-gray-700' : 'bg-white'} rounded-lg shadow-2xl p-8 w-full max-w-md`}>
          <div className="text-center mb-8">
            <div className="w-16 h-16 bg-gradient-to-r from-blue-500 to-purple-600 rounded-full mx-auto mb-4 flex items-center justify-center">
              <svg className="w-8 h-8 text-white" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 15v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2zm10-10V7a4 4 0 00-8 0v4h8z" />
              </svg>
            </div>
            <h1 className={`text-2xl font-bold ${isDarkTheme ? 'text-white' : 'text-gray-800'} mb-2`}>Encrypted Messenger</h1>
            <p className={`${isDarkTheme ? 'text-gray-300' : 'text-gray-600'}`}>End-to-end encrypted chat for Alpha & Bravo</p>
            
            {/* Theme toggle button */}
            <button
              onClick={toggleTheme}
              className={`mt-4 p-2 rounded-lg ${isDarkTheme ? 'bg-gray-700 text-yellow-400 hover:bg-gray-600' : 'bg-gray-100 text-gray-600 hover:bg-gray-200'} transition duration-200`}
              title={`Switch to ${isDarkTheme ? 'light' : 'dark'} theme`}
            >
              {isDarkTheme ? (
                <svg className="w-5 h-5" fill="currentColor" viewBox="0 0 20 20">
                  <path fillRule="evenodd" d="M10 2a1 1 0 011 1v1a1 1 0 11-2 0V3a1 1 0 011-1zm4 8a4 4 0 11-8 0 4 4 0 018 0zm-.464 4.95l.707.707a1 1 0 001.414-1.414l-.707-.707a1 1 0 00-1.414 1.414zm2.12-10.607a1 1 0 010 1.414l-.706.707a1 1 0 11-1.414-1.414l.707-.707a1 1 0 011.414 0zM17 11a1 1 0 100-2h-1a1 1 0 100 2h1zm-7 4a1 1 0 011 1v1a1 1 0 11-2 0v-1a1 1 0 011-1zM5.05 6.464A1 1 0 106.465 5.05l-.708-.707a1 1 0 00-1.414 1.414l.707.707zm1.414 8.486l-.707.707a1 1 0 01-1.414-1.414l.707-.707a1 1 0 011.414 1.414zM4 11a1 1 0 100-2H3a1 1 0 000 2h1z" clipRule="evenodd" />
                </svg>
              ) : (
                <svg className="w-5 h-5" fill="currentColor" viewBox="0 0 20 20">
                  <path d="M17.293 13.293A8 8 0 016.707 2.707a8.001 8.001 0 1010.586 10.586z" />
                </svg>
              )}
            </button>
          </div>
          
          <form onSubmit={handleLogin}>
            <div className="mb-6">
              <label className={`block ${isDarkTheme ? 'text-gray-300' : 'text-gray-700'} text-sm font-bold mb-2`}>
                Access Code
              </label>
              <input
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder="Enter your access code"
                className={`w-full px-4 py-3 border ${isDarkTheme ? 'border-gray-600 bg-gray-700 text-white placeholder-gray-400' : 'border-gray-300 bg-white text-gray-900 placeholder-gray-500'} rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent`}
                required
              />
              {loginError && (
                <p className="text-red-500 text-xs mt-2">{loginError}</p>
              )}
            </div>
            
            <button
              type="submit"
              className="w-full bg-gradient-to-r from-blue-500 to-purple-600 text-white py-3 px-4 rounded-lg hover:from-blue-600 hover:to-purple-700 transition duration-200 font-semibold"
            >
              Secure Login
            </button>
          </form>
          
          <div className={`mt-6 text-center text-xs ${isDarkTheme ? 'text-gray-400' : 'text-gray-500'}`}>
            <p>Alpha: alphabravocharlie</p>
            <p>Bravo: bravoalphacharlie</p>
          </div>
        </div>
      </div>
    );
  }

  // Chat interface
  return (
    <div className={`min-h-screen ${isDarkTheme ? 'bg-gray-900' : 'bg-gray-100'} flex flex-col`}>
      {/* Header */}
      <div className={`${isDarkTheme ? 'bg-gray-800 border-gray-700' : 'bg-white border-gray-200'} shadow-sm border-b px-6 py-4 flex justify-between items-center`}>
        <div className="flex items-center space-x-3">
          <div className="w-10 h-10 bg-gradient-to-r from-blue-500 to-purple-600 rounded-full flex items-center justify-center">
            <span className="text-white font-bold text-lg">{user[0]}</span>
          </div>
          <div>
            <h1 className={`text-xl font-semibold ${isDarkTheme ? 'text-white' : 'text-gray-800'}`}>
              {user} - Encrypted Chat
            </h1>
            <p className={`text-sm ${isDarkTheme ? 'text-gray-300' : 'text-gray-600'}`}>
              Chatting with {user === 'Alpha' ? 'Bravo' : 'Alpha'} 
              <span className={`ml-2 inline-block w-2 h-2 rounded-full ${wsConnected ? 'bg-green-400' : 'bg-red-400'}`}></span>
            </p>
          </div>
        </div>
        
        <div className="flex items-center space-x-3">
          <button
            onClick={toggleTheme}
            className={`p-2 rounded-lg ${isDarkTheme ? 'bg-gray-700 text-yellow-400 hover:bg-gray-600' : 'bg-gray-100 text-gray-600 hover:bg-gray-200'} transition duration-200`}
            title={`Switch to ${isDarkTheme ? 'light' : 'dark'} theme`}
          >
            {isDarkTheme ? (
              <svg className="w-5 h-5" fill="currentColor" viewBox="0 0 20 20">
                <path fillRule="evenodd" d="M10 2a1 1 0 011 1v1a1 1 0 11-2 0V3a1 1 0 011-1zm4 8a4 4 0 11-8 0 4 4 0 018 0zm-.464 4.95l.707.707a1 1 0 001.414-1.414l-.707-.707a1 1 0 00-1.414 1.414zm2.12-10.607a1 1 0 010 1.414l-.706.707a1 1 0 11-1.414-1.414l.707-.707a1 1 0 011.414 0zM17 11a1 1 0 100-2h-1a1 1 0 100 2h1zm-7 4a1 1 0 011 1v1a1 1 0 11-2 0v-1a1 1 0 011-1zM5.05 6.464A1 1 0 106.465 5.05l-.708-.707a1 1 0 00-1.414 1.414l.707.707zm1.414 8.486l-.707.707a1 1 0 01-1.414-1.414l.707-.707a1 1 0 011.414 1.414zM4 11a1 1 0 100-2H3a1 1 0 000 2h1z" clipRule="evenodd" />
              </svg>
            ) : (
              <svg className="w-5 h-5" fill="currentColor" viewBox="0 0 20 20">
                <path d="M17.293 13.293A8 8 0 016.707 2.707a8.001 8.001 0 1010.586 10.586z" />
              </svg>
            )}
          </button>
          <button
            onClick={handleClearHistory}
            className="px-3 py-1 text-sm bg-orange-500 text-white rounded-lg hover:bg-orange-600 transition duration-200"
          >
            Clear History
          </button>
          <button
            onClick={handleLogout}
            className="px-4 py-2 text-sm bg-red-500 text-white rounded-lg hover:bg-red-600 transition duration-200"
          >
            Logout
          </button>
        </div>
      </div>

      {/* Messages area */}
      <div className="flex-1 overflow-y-auto p-6 space-y-4">
        {messages.map((message) => (
          <div
            key={message.id}
            className={`max-w-xs lg:max-w-md px-4 py-2 rounded-lg ${
              message.sender === user
                ? 'bg-blue-500 text-white ml-auto'
                : `${isDarkTheme ? 'bg-gray-700 text-white border-gray-600' : 'bg-white text-gray-800 border-gray-200'} border`
            }`}
          >
            <p className="text-sm">{message.decrypted_content}</p>
            <p className={`text-xs mt-1 ${message.sender === user ? 'text-blue-100' : (isDarkTheme ? 'text-gray-400' : 'text-gray-500')}`}>
              {new Date(message.timestamp).toLocaleTimeString()}
            </p>
          </div>
        ))}
        <div ref={messagesEndRef} />
      </div>

      {/* Message input */}
      <div className={`${isDarkTheme ? 'bg-gray-800 border-gray-700' : 'bg-white border-gray-200'} border-t px-6 py-4`}>
        <form onSubmit={handleSendMessage} className="flex space-x-3">
          <input
            type="text"
            value={newMessage}
            onChange={(e) => setNewMessage(e.target.value)}
            placeholder="Type your encrypted message..."
            className={`flex-1 px-4 py-2 border ${isDarkTheme ? 'border-gray-600 bg-gray-700 text-white placeholder-gray-400' : 'border-gray-300 bg-white text-gray-900 placeholder-gray-500'} rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent`}
            required
          />
          <button
            type="submit"
            className="px-6 py-2 bg-blue-500 text-white rounded-lg hover:bg-blue-600 transition duration-200 font-semibold"
          >
            Send
          </button>
        </form>
      </div>
    </div>
  );
}

export default App;