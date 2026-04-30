import dotenv from 'dotenv'
import connectDB from './db/index.js'
import {app} from './app.js'
dotenv.config({
    path: '../.env'
})

connectDB()
.then(()=>{
        app.on("error",(error)=>{
            console.log("ERR" , error)
            throw error
        })
    
        const PORT = process.env.PORT || 8000
        app.listen(PORT, () => {
        console.log(`Server running on port ${PORT}`);
        });
})
.catch((error)=>{
    console.log("MONGO db connection failed!!!",error)
})























/*
import express from "express";


const app = express()

;(async ()=>{
    try {
        await mongoose.connect(`${process.env.MONGODB_URI}/${DB_NAME}`)
        app.on("error",(error)=>{
            console.log("ERRR:", error)
            throw error
        })

        app.listen(process.env.PORT,()=>{
            console.log(`APP is listening on port ${process.env.PORT}`)
        })


    } catch (error) {
        console.error("Error",error)
        throw error
    }
})()

*/