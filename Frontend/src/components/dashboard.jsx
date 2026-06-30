import React, { useState, useEffect } from 'react'
import { FiSearch, FiZap } from 'react-icons/fi'
import { User, FileText, Activity, PenTool } from 'lucide-react'
import { Outlet, useNavigate } from 'react-router-dom'
import { useAuth } from "../api/authContex"
import api from '../api/axios.js'

export default function Dashboard({expand}) {
    const [recentNote, setRecentNote] = useState([]);
    const navigate = useNavigate();
    const {user,setUser,playSound} = useAuth();
    
    useEffect(()=>{
        const getRecentNotes= async()=>{
        try {
            let res = await api.get('/recent',{withCredentials:true})
            setRecentNote(res.data.data)
        } catch (error) {
            console.log("error while fetching recent notes",error);
        }
    }
        getRecentNotes();
    },[])

  return (
    <div className='h-screen w-full bg-white dark:bg-gray-900 text-gray-900 dark:text-white transition-colors duration-300'>

      {/* Header */}
      <nav className='h-16 px-4 mb-3 w-full border-b dark:border-gray-700 flex items-center justify-between bg-white dark:bg-gray-800'>
        <div className='flex flex-col text-left'>
            <span className='text-2xl font-medium text-gray-900 dark:text-white'>Dashboard</span>
            <h4 className='text-gray-500 dark:text-gray-400 text-sm w-full'>Welcome back! Here's your overview.</h4>
        </div>
        <div className='flex justify-between items-center'>
            <div className='relative flex items-center'>
                <FiSearch className='absolute left-1 text-gray-500 dark:text-gray-400' size={16} />
                <input type="text" placeholder='search...' className='text-sm border dark:border-gray-600 h-8 pl-8 w-23 rounded-md md:w-auto bg-white dark:bg-gray-700 text-gray-900 dark:text-white placeholder-gray-400'/>
            </div>
            <User onClick={()=>{navigate('/dashboard/settings')}} size={20} className='text-gray-800 dark:text-gray-200 ml-4 cursor-pointer' />
        </div>
      </nav>

      {/* Status containers */}
      <div className='w-full flex justify-around items-center px-2'>

        <div className='flex items-center p-1.5'>
            <div className='relative h-20 w-50 rounded-md flex justify-around items-center shadow-md bg-white dark:bg-gray-800 border dark:border-gray-700'>
                <div className='text-left'>
                    <span className='text-sm text-gray-600 dark:text-gray-400'>Total Notes</span>
                    <h3 className='text-2xl font-semibold text-gray-900 dark:text-white'>{recentNote.length || 0}</h3>
                </div>
                <div className='h-8 w-8 rounded-md flex justify-center items-center bg-gray-200 dark:bg-gray-700'>
                    <FileText size={24} className='text-gray-600 dark:text-gray-300'/>
                </div>
            </div>
        </div>

        <div className='flex items-center p-1.5'>
            <div className='relative h-20 w-50 rounded-md flex justify-around items-center shadow-md bg-white dark:bg-gray-800 border dark:border-gray-700'>
                <div className='text-left'>
                    <span className='text-sm text-gray-600 dark:text-gray-400'>Accuracy Rate</span>
                    <h3 className='text-2xl font-semibold text-gray-900 dark:text-white'>97.8%</h3>
                </div>
                <div className='h-8 w-8 rounded-md flex justify-center items-center bg-gray-200 dark:bg-gray-700'>
                    <Activity size={24} className='text-gray-600 dark:text-gray-300'/>
                </div>
            </div>
        </div>

        <div className='flex items-center p-1.5'>
            <div className='relative h-20 w-50 rounded-md flex justify-around items-center shadow-md bg-white dark:bg-gray-800 border dark:border-gray-700'>
                <div className='text-left'>
                    <span className='text-sm text-gray-600 dark:text-gray-400'>Avg.Response</span>
                    <h3 className='text-2xl font-semibold text-gray-900 dark:text-white'>28ms</h3>
                </div>
                <div className='h-8 w-8 rounded-md flex justify-center items-center bg-gray-200 dark:bg-gray-700'>
                    <FiZap size={24} className='text-gray-600 dark:text-gray-300'/>
                </div>
            </div>
        </div>

      </div>

      {/* Action containers */}
      <div className='h-78 w-full p-6 flex items-center justify-center'>
        <div className='h-60 w-170 flex flex-col items-center rounded-md transform transition-all ease-out duration-300 hover:scale-101 hover:shadow-indigo-300 shadow-lg bg-white dark:bg-gray-800 border dark:border-gray-700'>
            <div className='relative flex flex-col w-full items-start h-20'>
                <div className='absolute left-3 top-4'>
                    <h3 className='font-semibold text-[1rem] px-4 text-left text-gray-900 dark:text-white'>Quick Actions</h3>
                    <span className='text-sm font-light text-gray-600 dark:text-gray-400'>Get started with air writing</span>
                </div>
            </div>
            <div className='h-50 p-4 flex justify-between gap-3 items-center'>
                <button onClick={()=>{ navigate('/dashboard/livewriting')}} className='h-25 w-80 flex flex-col justify-center items-center bg-gradient-to-tr from-indigo-400 to-indigo-700 text-cyan-100 transform transition-all ease-out duration-300 hover:scale-107 hover:shadow-lg rounded-md'>
                    <PenTool size={14} />
                    <span className='font-medium'>Start Writing</span>
                    <span className='text-sm'>Begin a new session</span>
                </button>
                <button onClick={()=>{ navigate('/dashboard/notes')}} className='h-25 w-80 flex flex-col justify-center items-center text-indigo-400 transition-all ease duration-300 hover:bg-gray-100 dark:hover:bg-gray-700 border dark:border-gray-600 rounded-md'>
                    <FileText size={14} />
                    <span className='font-medium'>View Notes</span>
                    <span className='text-sm'>Browse your notes</span>
                </button>
            </div>
        </div>
        <Outlet/>
      </div>

      {/* Recent notes */}
      <div className='w-full px-6 flex flex-col justify-self-center items-center'>
        <div className='w-full flex flex-col justify-start items-center border dark:border-gray-700 rounded-md bg-white dark:bg-gray-800'>
            <div className='w-full p-2 flex justify-between items-center border-b dark:border-gray-700 relative'>
                <div className='flex flex-col'>
                    <span className='font-semibold text-left text-gray-900 dark:text-white'>Recent Notes</span>
                    <span className='text-sm font-light text-gray-600 dark:text-gray-400'>Your latest air-written notes</span>
                </div>
                <button onClick={()=>{ navigate('/dashboard/notes')}} className='h-7 w-20 absolute right-6 top-3 hover:bg-gradient-to-tr from-indigo-400 to-indigo-700 hover:text-cyan-100 rounded-md text-gray-900 dark:text-white'>
                    <span className='font-semibold text-[15px]'>View All</span>
                </button>
            </div>

            {/* Notes */}
            <div className='h-full p-2.5 w-full justify-evenly flex flex-wrap items-center gap-2'>
                {recentNote.length > 0 && recentNote.map((item,index)=>(
                <div key={item?._id} className='w-[30%] h-30 p-2 flex flex-col justify-start bg-white dark:bg-gray-700 shadow-lg rounded-md border dark:border-gray-600 transform transition-all duration-300 hover:scale-[1.02]'>
                    <span className='font-semibold text-left line-clamp-1 text-gray-900 dark:text-white'>{item?.title}</span>
                    <span className='text-sm text-left line-clamp-2 text-gray-600 dark:text-gray-400'>{item?.recognizedText}</span>
                    <span className='text-sm text-left mt-3 text-gray-500 dark:text-gray-400'>2 hour ago</span>
                </div>
                ))}
            </div>
        </div>
      </div>

    </div>
  )
}