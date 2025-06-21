from fastapi import FastAPI, APIRouter, WebSocket, WebSocketDisconnect, HTTPException
from fastapi.security import HTTPBearer, HTTPAuthorizationCredentials
from fastapi.middleware.cors import CORSMiddleware
from dotenv import load_dotenv
from motor.motor_asyncio import AsyncIOMotorClient
from pydantic import BaseModel, Field
from typing import List, Optional, Dict
import os
import json
import uuid
from datetime import datetime
from pathlib import Path
import logging

ROOT_DIR = Path(__file__).parent
load_dotenv(ROOT_DIR / '.env')

# MongoDB connection
mongo_url = os.environ['MONGO_URL']
client = AsyncIOMotorClient(mongo_url)
db = client[os.environ['DB_NAME']]

# Create the main app
app = FastAPI()
api_router = APIRouter(prefix="/api")

# In-memory storage for active WebSocket connections
active_connections: Dict[str, WebSocket] = {}

# Security
security = HTTPBearer()

# Models
class LoginRequest(BaseModel):
    password: str

class LoginResponse(BaseModel):
    success: bool
    user: Optional[str] = None
    token: str
    message: str

class Message(BaseModel):
    id: str = Field(default_factory=lambda: str(uuid.uuid4()))
    sender: str
    receiver: str
    encrypted_content: str  # This will store the encrypted message
    timestamp: datetime = Field(default_factory=datetime.utcnow)

class MessageCreate(BaseModel):
    receiver: str
    encrypted_content: str

class User(BaseModel):
    id: str = Field(default_factory=lambda: str(uuid.uuid4()))
    username: str
    created_at: datetime = Field(default_factory=datetime.utcnow)

# Hardcoded authentication
USERS = {
    "alphabravocharlie": "Alpha",
    "bravoalphacharlie": "Bravo"
}

# Authentication endpoint
@api_router.post("/login", response_model=LoginResponse)
async def login(request: LoginRequest):
    if request.password in USERS:
        username = USERS[request.password]
        
        # Check if user exists in database, if not create
        existing_user = await db.users.find_one({"username": username})
        if not existing_user:
            user_obj = User(username=username)
            await db.users.insert_one(user_obj.dict())
        
        # Generate a simple token (in production, use JWT)
        token = str(uuid.uuid4())
        
        return LoginResponse(
            success=True,
            user=username,
            token=token,
            message=f"Welcome {username}!"
        )
    else:
        return LoginResponse(
            success=False,
            message="Invalid password"
        )

# Get messages endpoint
@api_router.get("/messages/{user}", response_model=List[Message])
async def get_messages(user: str):
    # Get all messages where user is sender or receiver
    messages = await db.messages.find({
        "$or": [
            {"sender": user},
            {"receiver": user}
        ]
    }).sort("timestamp", 1).to_list(1000)
    
    return [Message(**msg) for msg in messages]

# Send message endpoint
@api_router.post("/messages", response_model=Message)
async def send_message(message: MessageCreate, sender: str):
    # Create message object
    msg_obj = Message(
        sender=sender,
        receiver=message.receiver,
        encrypted_content=message.encrypted_content
    )
    
    # Save to database
    await db.messages.insert_one(msg_obj.dict())
    
    # Send real-time notification via WebSocket if receiver is connected
    if message.receiver in active_connections:
        try:
            await active_connections[message.receiver].send_text(
                json.dumps({
                    "type": "new_message",
                    "message": msg_obj.dict(default=str)
                })
            )
        except Exception as e:
            # Remove dead connection
            active_connections.pop(message.receiver, None)
    
    return msg_obj

# WebSocket endpoint for real-time messaging
@api_router.websocket("/ws/{user}")
async def websocket_endpoint(websocket: WebSocket, user: str):
    await websocket.accept()
    active_connections[user] = websocket
    
    try:
        while True:
            # Keep connection alive by waiting for messages
            data = await websocket.receive_text()
            # Echo back for connection health check
            await websocket.send_text(json.dumps({"type": "pong", "data": data}))
    except WebSocketDisconnect:
        active_connections.pop(user, None)
    except Exception as e:
        active_connections.pop(user, None)

# Health check
@api_router.get("/")
async def root():
    return {"message": "Encrypted Messenger API"}

# Include router
app.include_router(api_router)

# CORS middleware
app.add_middleware(
    CORSMiddleware,
    allow_credentials=True,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

# Configure logging
logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s - %(name)s - %(levelname)s - %(message)s'
)
logger = logging.getLogger(__name__)

@app.on_event("shutdown")
async def shutdown_db_client():
    client.close()